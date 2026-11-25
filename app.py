from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
STORES = ("Monarca", "Carrefour")
TANDIL = ZoneInfo("America/Argentina/Buenos_Aires")


def cents(value):
    try:
        amount = Decimal(str(value))
        return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if amount.is_finite() else None
    except (InvalidOperation, ValueError):
        return None


def active(promo):
    now = datetime.now(TANDIL)
    try:
        start, end = (
            datetime.strptime(promo[field], "%d/%m/%Y %H:%M:%S").replace(tzinfo=TANDIL)
            for field in ("fromDate", "dateTo")
        )
        return int(end.timestamp() * 1000) if start <= now <= end else None
    except (TypeError, ValueError, KeyError):
        return None


def monarca_promo(promo):
    label = promo.get("content") or promo.get("title") or promo.get("description")
    price = cents(promo.get("totalPrice"))
    quantity = promo.get("productQuantity")
    kind = promo.get("type")
    group = max(1, quantity or 0) if kind == "PERCENTAGE_OFF" else quantity
    expires = active(promo)
    # Keep weekday/card-limited campaigns visible in the brochure. The
    # comparator only applies a promo price when its mechanics are verified.
    if expires is None or kind not in {"PERCENTAGE_OFF", "PERCENTAGE_N_OFF", "NXM"}:
        price = None
    return {
        "label": label, "group": group, "price": price, "card": False,
        "expires": expires, "weekDays": promo.get("weekDays") or [],
    }


def barcode(value):
    value = str(value or "")
    return value.zfill(14) if re.fullmatch(r"[0-9]{8}|[0-9]{12,14}", value) else ""


def monarca_products(data):
    for product in data["products"]["content"]:
        price = cents(product.get("price"))
        if price is None or price <= 0:
            continue
        yield {
            "store": "Monarca", "id": str(product["id"]), "price": price,
            "ean": barcode(product.get("barcode")),
            "name": " · ".join(dict.fromkeys(part.strip() for part in (
                product.get("description") or "", product.get("brand") or "",
                product.get("presentation") or "",
            ) if part.strip())),
            "image": (product.get("featuredImage") or {}).get("path"),
            "promos": [monarca_promo(promo) for promo in product.get("promotions") or []],
            "link": "https://web.monarcadigital.com.ar/search?" + urlencode({"q": product.get("barcode") or product["description"]}),
        }


def carrefour_products(data, seller_id=None):
    for product in data["products"]:
        for item in product.get("items") or []:
            offers = [
                {**(seller.get("commertialOffer") or {}), "seller": str(seller["sellerId"])}
                for seller in item.get("sellers") or []
                if seller_id is None or str(seller.get("sellerId")) == seller_id
            ]
            offers = [offer for offer in offers if offer.get("AvailableQuantity", 0) > 0 and (cents(offer.get("Price")) or 0) > 0]
            if not offers:
                continue
            offer = min(offers, key=lambda entry: cents(entry["Price"]))
            price = cents(offer["Price"])
            promos = []
            regular = cents(offer.get("ListPrice"))
            if regular and regular > price:
                promos.append({"label": f"Rebaja incluida · antes ${regular / 100:,.2f}".translate(str.maketrans(",.", ".,")), "price": None})
            highlights = offer.get("discountHighlights") or offer.get("DiscountHighLight") or []
            for highlight in highlights:
                promos.append({"label": highlight.get("name"), "price": None})
            teasers = (offer.get("PromotionTeasers") or offer.get("promotionTeasers")
                       or offer.get("teasers") or offer.get("Teasers")
                       or product.get("PromotionTeasers") or product.get("promotionTeasers") or product.get("teasers") or [])
            for teaser in teasers:
                label = teaser.get("name") or teaser.get("Name") or teaser.get("<Name>k__BackingField")
                conditions = (teaser.get("conditions") or teaser.get("Conditions")
                              or teaser.get("<Conditions>k__BackingField") or {})
                condition_parameters = (conditions.get("parameters") or conditions.get("Parameters")
                                        or conditions.get("<Parameters>k__BackingField") or [])
                minimum_quantity = (conditions.get("minimumQuantity") or conditions.get("MinimumQuantity")
                                    or conditions.get("<MinimumQuantity>k__BackingField") or 0)
                general_values = (teaser.get("generalValues") or teaser.get("GeneralValues")
                                 or teaser.get("<GeneralValues>k__BackingField"))
                effects = (teaser.get("effects") or teaser.get("Effects")
                           or teaser.get("<Effects>k__BackingField") or {})
                discount = (effects.get("parameters") or effects.get("Parameters")
                            or effects.get("<Parameters>k__BackingField") or [])
                def parameter_value(parameter, key):
                    title = key.title()
                    return (parameter.get(key) or parameter.get(title)
                            or parameter.get("<" + title + ">k__BackingField"))
                bins = {parameter_value(param, "name") for param in condition_parameters}
                card_discount = [
                    {"name": parameter_value(param, "name"), "value": parameter_value(param, "value")}
                    for param in discount
                ]
                card = (
                    label == "Tarjeta Carrefour 15%"
                    and bins == {"RestrictionsBins"}
                    and not general_values
                    and not minimum_quantity
                    and card_discount == [{"name": "PercentualDiscount", "value": "15"}]
                )
                promo = {"label": label, "price": (price * 85 + 50) // 100 if card else None, "group": 1, "card": card}
                pair = re.match(r"^PROMO-2do al (\d+)%\s+Max (\d+) unidades\b", label or "", re.IGNORECASE)
                params = {parameter_value(param, "name"): parameter_value(param, "value") for param in condition_parameters}
                effect = next((parameter_value(param, "value") for param in discount
                               if parameter_value(param, "name") == "PercentualDiscount"), None)
                if pair and minimum_quantity == 2 and set(params) == {"SkuIdsList"}:
                    percent, limit = map(int, pair.groups())
                    if (
                        0 < percent <= 100 and limit >= 2 and not general_values
                        and str(item["itemId"]) in (params["SkuIdsList"] or "").split(",")
                        and len(discount) == 1 and cents(effect) == percent * 50
                    ):
                        promo.update(group=2, limit=limit, price=(price * (200 - percent) + 50) // 100, estimated=True)
                promos.append(promo)
            clusters = product.get("productClusters") or {}
            if isinstance(clusters, list):
                clusters = {str(cluster.get("id")): cluster.get("name") for cluster in clusters if isinstance(cluster, dict)}
            cluster_promos = [
                name for name in clusters.values()
                if isinstance(name, str) and re.search(r"\b(2do|segunda|3x2|4x3|\d+%|ahorro|descuento|promo)", name, re.I)
            ]
            promos.extend({"label": name, "price": None, "estimated": True} for name in cluster_promos)
            categories = product.get("categories") or []
            if isinstance(categories, str):
                categories = [categories]
            yield {
                "store": "Carrefour", "id": str(item["itemId"]), "seller": offer["seller"], "price": price,
                "ean": barcode(item.get("ean")), "name": product["productName"],
                "image": next((image.get("imageUrl") for image in item.get("images") or []), None),
                "promos": promos, "categories": categories,
                "link": "https://www.carrefour.com.ar/" + product["linkText"] + "/p",
            }


def monarca_promotions():
    headers = {"User-Agent": "curl/8.5.0", "Accept": "*/*"}
    # The empty query returns the full online catalog in pages. Keep products
    # with a currently active promotion and group by their returned category.
    categories = {}
    page = 0
    while True:
        url = "https://api.monarcadigital.com.ar/products/search?" + urlencode({
            "page": page, "size": 100, "query": "",
        })
        with urlopen(Request(url, headers=headers), timeout=15) as response:
            data = json.load(response)
        product_data = data.get("products") or {}
        content = product_data.get("content") or []
        for raw in content:
            product = next(monarca_products({"products": {"content": [raw]}}), None)
            if not product:
                continue
            labels = [promo["label"] for promo in product["promos"]
                      if promo.get("label")]
            if not labels:
                continue
            category = raw.get("category") or {}
            name = category.get("description") or category.get("name") or "Otros"
            categories.setdefault(name, []).append({**product, "promos": labels})
        total_pages = (product_data.get("totalPages") or 1)
        page += 1
        if page >= total_pages:
            break
        if page >= 500:
            raise ValueError("Catálogo Monarca supera el máximo de páginas")
    return [{"name": name, "products": items} for name, items in sorted(categories.items())]

def _carrefour_category(product):
    paths = product.get("categories") or []
    for path in reversed(paths):
        parts = [unquote(part).strip() for part in str(path).split("/") if part.strip()]
        if parts:
            return parts[-1].replace("-", " ").title()
    name = product.get("name", "").casefold()
    choices = (
        ("Almacén", ("yerba", "azucar", "arroz", "fideo", "galletita", "conserva")),
        ("Bebidas", ("bebida", "gaseosa", "agua", "cerveza", "vino")),
        ("Lácteos y frescos", ("leche", "queso", "yogur", "carne", "fruta", "verdura")),
        ("Limpieza", ("detergente", "lavandina", "limpieza")),
        ("Perfumería", ("shampoo", "perfumer", "higiene")),
        ("Mascotas", ("mascota", "perro", "gato")),
        ("Hogar", ("hogar", "bazar", "textil")),
    )
    for category, terms in choices:
        if any(term in name for term in terms):
            return category
    return "Otros"


@lru_cache(maxsize=96)
def carrefour_promotions(page, cache_window):
    # Read four catalog pages ordered by discount. The client can request the
    # next batch without keeping a serverless function open for a full scan.
    def fetch_catalog_page(catalog_page):
        start = catalog_page * 50
        headers = {"User-Agent": "curl/8.5.0", "Accept": "*/*"}
        params = {"O": "OrderByBestDiscountDESC", "_from": start, "_to": start + 49}
        url = "https://www.carrefour.com.ar/api/catalog_system/pub/products/search?" + urlencode(params)
        try:
            with urlopen(Request(url, headers=headers), timeout=8) as response:
                return json.load(response)
        except OSError:
            fallback = "https://www.carrefour.com.ar/api/catalog_system/pub/products/search?" + urlencode(
                {"_from": start, "_to": start + 49}
            )
            with urlopen(Request(fallback, headers=headers), timeout=8) as response:
                return json.load(response)

    pages = range(page * 4, page * 4 + 4)
    with ThreadPoolExecutor(max_workers=4) as pool:
        catalog_pages = list(pool.map(fetch_catalog_page, pages))
    categories = {}
    seen = set()
    for raw_page in catalog_pages:
        for product in carrefour_products({"products": raw_page}, seller_id="1"):
            labels = list(dict.fromkeys(
                promo.get("label") + (" · condición a confirmar" if promo.get("estimated") else "")
                for promo in product.get("promos") or [] if promo.get("label")
            ))
            if not labels or product["id"] in seen:
                continue
            seen.add(product["id"])
            product["promos"] = labels
            category = _carrefour_category(product)
            categories.setdefault(category, []).append(product)
    has_more = all(len(catalog_page) == 50 for catalog_page in catalog_pages)
    return [{"name": name, "products": items} for name, items in sorted(categories.items())], has_more

@lru_cache(maxsize=24)
def promotion_catalog(cache_window, carrefour_page=0):
    jobs = {"Carrefour": lambda: carrefour_promotions(carrefour_page, cache_window)}
    if carrefour_page == 0:
        jobs["Monarca"] = monarca_promotions
    result = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = {pool.submit(fetcher): store for store, fetcher in jobs.items()}
        for task in as_completed(tasks):
            store = tasks[task]
            try:
                categories, *paging = task.result() if store == "Carrefour" else (task.result(),)
                entry = {"store": store, "categories": categories}
                if store == "Carrefour":
                    entry["hasMore"] = paging[0]
                result.append(entry)
            except (OSError, ValueError, KeyError, TypeError):
                result.append({"store": store, "error": True})
    return sorted(result, key=lambda item: STORES.index(item["store"]))



@lru_cache(maxsize=128)
def search_store(store, query, cache_window):
    if store == "Monarca":
        url = "https://api.monarcadigital.com.ar/products/search?" + urlencode({"page": 0, "size": 16, "query": query})
        parse = monarca_products
    else:
        url = "https://www.carrefour.com.ar/api/io/_v/api/intelligent-search/product_search?" + urlencode({"count": 16, "query": query}, quote_via=quote)
        parse = carrefour_products
    headers = {"User-Agent": "curl/8.5.0", "Accept": "*/*"}
    with urlopen(Request(url, headers=headers), timeout=8) as response:
        products = list(parse(json.load(response)))
    if store == "Monarca":
        seen = {product["id"] for product in products}
        terms = monarca_search_terms(query)
        for term in terms:
            alternate_url = "https://api.monarcadigital.com.ar/products/search?" + urlencode({"page": 0, "size": 16, "query": term})
            with urlopen(Request(alternate_url, headers=headers), timeout=8) as response:
                for product in monarca_products(json.load(response)):
                    if product["id"] not in seen:
                        products.append(product)
                        seen.add(product["id"])
    if store == "Carrefour" and not products:
        # Intelligent Search sometimes returns zero hits for broad terms such as "azucar".
        fallback = "https://www.carrefour.com.ar/api/catalog_system/pub/products/search?" + urlencode({"ft": query}, quote_via=quote)
        with urlopen(Request(fallback, headers=headers), timeout=8) as response:
            products = list(carrefour_products({"products": json.load(response)}))
    return products


def monarca_search_terms(query):
    normalized = query.casefold().replace("á", "a").replace("é", "e").replace("í", "i").replace("ó", "o").replace("ú", "u")
    if "papel" in normalized and any(word in normalized for word in ("higienico", "higienica", "rollo")):
        return ["papel hoja", "papel higienico"] if "papel hoja" not in normalized else ["papel higienico"]
    return []


def delivery_options(logistics):
    options = {}
    for sla in logistics.get("slas") or []:
        if sla.get("deliveryChannel") != "delivery":
            continue
        couriers = tuple(sorted({entry.get("courierId") or "" for entry in sla.get("deliveryIds") or []}))
        windows = sla.get("availableDeliveryWindows") or ([sla["deliveryWindow"]] if sla.get("deliveryWindow") else [])
        for window in windows:
            price = window.get("price")
            if type(price) is int and price >= 0:
                key = (sla["id"], couriers, window["startDateUtc"], window["endDateUtc"])
                options[key] = price + (window.get("tax") or 0)
    return options


def quote_carrefour(items, postal_code):
    request = Request(
        "https://www.carrefour.com.ar/api/checkout/pub/orderForms/simulation",
        data=json.dumps({"items": items, "postalCode": postal_code, "country": "ARG"}).encode(),
        headers={"User-Agent": "curl/8.5.0", "Accept": "*/*", "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=14) as response:
        data = json.load(response)
    products = data["items"]
    logistics = {entry["itemIndex"]: entry for entry in data["logisticsInfo"]}
    available = len(products) == len(items) and all(
        product.get("availability") == "available" and product.get("quantity") == original["quantity"]
        and str(product.get("id")) == original["id"]
        for product, original in zip(products, items)
    )
    if not available:
        return {"available": False}
    window_maps = [delivery_options(logistics.get(index, {})) for index in range(len(items))]
    shared_windows = set.intersection(*(set(options) for options in window_maps))
    # Matching fees on a shared courier/slot describe the same delivery. Different fees have no verified total.
    windows = [
        (window_maps[0][key], key[2])
        for key in shared_windows
        if all(options[key] == window_maps[0][key] for options in window_maps)
    ]
    shipping, starts = min(windows) if windows else (None, None)
    lines = []
    for product in products:
        line_total = (product.get("priceDefinition") or {}).get("total")
        if type(line_total) is not int or line_total < 0:
            raise ValueError("Missing quote total")
        lines.append({
            "total": line_total,
            "discount": line_total < product["listPrice"] * product["quantity"]
            if type(product.get("listPrice")) is int else bool(product.get("priceTags")),
        })
    return {"available": True, "shipping": shipping, "starts": starts, "lines": lines}


def parse_quote(payload):
    items = payload["items"]
    postal_code = payload["postalCode"]
    if not isinstance(postal_code, str) or not re.fullmatch(r"(?:[0-9]{4}|[A-Z][0-9]{4}[A-Z]{3})", postal_code):
        raise ValueError("Invalid postcode")
    if not isinstance(items, list) or not 1 <= len(items) <= 60:
        raise ValueError("Invalid items")
    for item in items:
        if (
            not isinstance(item, dict)
            or not re.fullmatch(r"[0-9]{1,20}", str(item.get("id", "")))
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", str(item.get("seller", "")))
            or type(item.get("quantity")) is not int or not 1 <= item["quantity"] <= 99
        ):
            raise ValueError("Invalid item")
    return [{"id": str(i["id"]), "seller": str(i["seller"]), "quantity": i["quantity"]} for i in items], postal_code


class Handler(BaseHTTPRequestHandler):
    def send(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload, status=200):
        self.send(status, "application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode())

    def do_POST(self):
        if urlsplit(self.path).path != "/api/quote":
            self.send_json({"error": "Ruta desconocida."}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 12000:
                raise ValueError("Invalid length")
            items, postal_code = parse_quote(json.loads(self.rfile.read(length)))
        except (ValueError, KeyError, TypeError):
            self.send_json({"error": "Revisá el código postal y las cantidades."}, 400)
            return
        try:
            self.send_json(quote_carrefour(items, postal_code))
        except (OSError, ValueError, KeyError, TypeError):
            self.send_json({"error": "Carrefour no pudo cotizar esta compra."}, 502)

    def do_GET(self):
        url = urlsplit(self.path)
        assets = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/planning.js": ("planning.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
            "/canasta.svg": ("canasta.svg", "image/svg+xml"),
            "/fonts/bricolage-grotesque-latin.woff2": ("fonts/bricolage-grotesque-latin.woff2", "font/woff2"),
        }
        if url.path in assets:
            name, mime = assets[url.path]
            content_type = mime + "; charset=utf-8" if mime != "font/woff2" else mime
            self.send(200, content_type, (ROOT / "public" / name).read_bytes())
            return
        if url.path == "/api/promotions":
            try:
                page = int(parse_qs(url.query).get("page", ["0"])[0])
                if not 0 <= page <= 100:
                    raise ValueError("Invalid page")
            except (TypeError, ValueError):
                self.send_json({"error": "Página de promociones inválida."}, 400)
                return
            catalog = promotion_catalog(int(time.time() // 600), page)
            self.send_json({"stores": catalog})
            return
        if url.path != "/api/search":
            self.send_json({"error": "Ruta desconocida."}, 404)
            return
        query = parse_qs(url.query).get("q", [""])[0].strip()
        if not 2 <= len(query) <= 100:
            self.send_json({"error": "Ingresá entre 2 y 100 caracteres."}, 400)
            return
        products, errors = [], []
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = {pool.submit(search_store, store, query.lower(), int(time.time() // 120)): store for store in STORES}
            for task in as_completed(tasks):
                try:
                    products.extend(task.result())
                except (OSError, ValueError, KeyError, TypeError):
                    errors.append(tasks[task])
        self.send_json({"products": products, "errors": errors}, 502 if len(errors) == len(STORES) else 200)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Comparador local de Monarca y Carrefour")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    print(f"Changuito Tandil · http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
