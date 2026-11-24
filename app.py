from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, quote, urlencode, urlsplit
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
    if expires is None or promo.get("weekDays") or kind not in {"PERCENTAGE_OFF", "PERCENTAGE_N_OFF", "NXM"}:
        price = None
    return {"label": label, "group": group, "price": price, "card": False, "expires": expires}


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


def carrefour_products(data):
    for product in data["products"]:
        for item in product.get("items") or []:
            offers = [{**(seller.get("commertialOffer") or {}), "seller": str(seller["sellerId"])} for seller in item.get("sellers") or []]
            offers = [offer for offer in offers if offer.get("AvailableQuantity", 0) > 0 and (cents(offer.get("Price")) or 0) > 0]
            if not offers:
                continue
            offer = min(offers, key=lambda entry: cents(entry["Price"]))
            price = cents(offer["Price"])
            promos = []
            regular = cents(offer.get("ListPrice"))
            if regular and regular > price:
                promos.append({"label": f"Rebaja incluida · antes ${regular / 100:,.2f}".translate(str.maketrans(",.", ".,")), "price": None})
            for highlight in offer.get("discountHighlights") or []:
                promos.append({"label": highlight.get("name"), "price": None})
            for teaser in offer.get("teasers") or []:
                label = teaser.get("name")
                conditions = teaser.get("conditions") or {}
                discount = (teaser.get("effects") or {}).get("parameters") or []
                card = (
                    label == "Tarjeta Carrefour 15%"
                    and {param.get("name") for param in (conditions.get("parameters") or [])} == {"RestrictionsBins"}
                    and not teaser.get("generalValues")
                    and not conditions.get("minimumQuantity")
                    and discount == [{"name": "PercentualDiscount", "value": "15"}]
                )
                promo = {"label": label, "price": (price * 85 + 50) // 100 if card else None, "group": 1, "card": card}
                pair = re.match(r"^PROMO-2do al (\d+)%\s+Max (\d+) unidades\b", label or "", re.IGNORECASE)
                params = {param.get("name"): param.get("value") for param in conditions.get("parameters") or []}
                effect = next((param.get("value") for param in discount if param.get("name") == "PercentualDiscount"), None)
                if pair and conditions.get("minimumQuantity") == 2 and set(params) == {"SkuIdsList"}:
                    percent, limit = map(int, pair.groups())
                    if (
                        0 < percent <= 100 and limit >= 2 and not teaser.get("generalValues")
                        and str(item["itemId"]) in (params["SkuIdsList"] or "").split(",")
                        and len(discount) == 1 and cents(effect) == percent * 50
                    ):
                        promo.update(group=2, limit=limit, price=(price * (200 - percent) + 50) // 100, estimated=True)
                promos.append(promo)
            yield {
                "store": "Carrefour", "id": str(item["itemId"]), "seller": offer["seller"], "price": price,
                "ean": barcode(item.get("ean")), "name": product["productName"],
                "image": next((image.get("imageUrl") for image in item.get("images") or []), None),
                "promos": promos, "link": "https://www.carrefour.com.ar/" + product["linkText"] + "/p",
            }


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
        assets = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/planning.js": ("planning.js", "text/javascript"), "/style.css": ("style.css", "text/css")}
        if url.path in assets:
            name, mime = assets[url.path]
            self.send(200, mime + "; charset=utf-8", (ROOT / "public" / name).read_bytes())
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
