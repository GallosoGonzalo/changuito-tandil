"use strict";

const stores = ["Monarca", "Carrefour"];
const money = new Intl.NumberFormat("es-AR", {style: "currency", currency: "ARS"});
const fmt = (value) => money.format(value / 100);
const find = (selector) => document.querySelector(selector);
const results = find("#results");
const status = find("#status");
let recommended = null;
let basketRevision = 0;
let groupsByTerm = [];

function readSaved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const basket = new Map(readSaved("changuito-basket", []));

function save() {
  try {
    localStorage.setItem("changuito-basket", JSON.stringify([...basket]));
  } catch {
    // The current list still works when storage is unavailable.
  }
}

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#i-" + id);
  svg.append(use);
  return svg;
}

function button(label, action, className) {
  const node = el("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function productKey(product) {
  return product.ean || (product.store + ":" + product.id);
}

function groupProducts(products) {
  const groups = new Map();
  for (const item of products) {
    const key = productKey(item);
    if (!groups.has(key)) groups.set(key, []);
    const offers = groups.get(key);
    const existing = offers.findIndex((offer) => offer.store === item.store);
    if (existing === -1) offers.push(item);
    else if (offers[existing].price > item.price) offers[existing] = item;
  }
  return [...groups];
}

function priceFor(product, quantity, at = Date.now()) {
  const fullPrice = {total: product.price * quantity, promo: null};
  return product.promos.reduce((best, promo) => {
    if (!Number.isInteger(promo.group) || promo.group < 1 || !Number.isInteger(promo.price)
        || promo.price < 0 || (promo.expires && at > promo.expires) || promo.card) return best;
    const groups = Math.floor(Math.min(quantity, promo.limit ?? quantity) / promo.group);
    const total = groups * promo.price + (quantity - groups * promo.group) * product.price;
    return groups && total < best.total ? {total, promo: promo.label + (promo.estimated ? " · estimado" : "")} : best;
  }, fullPrice);
}

function allocation(offers, quantity, at = Date.now()) {
  if (offers.length === 1) {
    return [{product: offers[0], quantity, ...priceFor(offers[0], quantity, at)}];
  }
  const [first, second] = offers;
  let best = {total: Infinity, lines: []};
  for (let firstQuantity = 0; firstQuantity <= quantity; firstQuantity++) {
    const options = [
      {product: first, quantity: firstQuantity, ...priceFor(first, firstQuantity, at)},
      {product: second, quantity: quantity - firstQuantity, ...priceFor(second, quantity - firstQuantity, at)},
    ];
    const total = options[0].total + options[1].total;
    const lines = options.filter((line) => line.quantity);
    if (total < best.total || (total === best.total && lines.length < best.lines.length)) {
      best = {total, lines};
    }
  }
  return best.lines;
}

function changeQuantity(key, delta, offers) {
  const current = basket.get(key);
  const quantity = Math.min(99, (current?.quantity || 0) + delta);
  if (quantity <= 0) basket.delete(key);
  else basket.set(key, {quantity, offers: offers || current.offers});
  save();
  resetQuote();
}

function renderResults() {
  results.replaceChildren();
  for (const {term, groups} of groupsByTerm) {
    results.append(el("h3", term, "term"));
    if (!groups.length) results.append(el("p", "Sin resultados disponibles. Probá con otro nombre o marca.", "no-results"));
    const ordered = [...groups].sort((a, b) => b[1].length - a[1].length
      || Math.min(...a[1].map((item) => priceFor(item, 1).total)) - Math.min(...b[1].map((item) => priceFor(item, 1).total)));
    for (const [key, offers] of ordered) {
      const product = offers[0];
      const row = el("article", undefined, "product");
      const media = el("div", undefined, "product-media");
      media.append(icon("package"));
      if (product.image?.startsWith("https://")) {
        const image = el("img");
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), {once: true});
        image.src = product.image;
        media.append(image);
      }
      const prices = el("div", undefined, "offers");
      for (const offer of [...offers].sort((a, b) => stores.indexOf(a.store) - stores.indexOf(b.store))) {
        const line = el("div", undefined, "offer");
        const estimated = priceFor(offer, 1);
        line.append(el("span", offer.store, "offer-store"), el("strong", fmt(estimated.total), "offer-price"));
        if (estimated.total < offer.price) line.append(el("small", "Precio regular: " + fmt(offer.price)));
        const promos = [...new Set(offer.promos.map((promo) => promo.label).filter(Boolean))];
        if (promos.length) line.append(el("div", promos.join(" · "), "promo"));
        const pair = priceFor(offer, 2);
        if (offer.promos.some((promo) => promo.estimated && promo.group === 2) && pair.total < estimated.total * 2) {
          line.append(el("div", "2 unidades por " + fmt(pair.total) + " · estimado", "promo"));
        }
        prices.append(line);
      }
      let feedbackTimer;
      const add = button("Agregar", () => {
        changeQuantity(key, 1, offers);
        status.textContent = "Agregaste " + product.name + " a tu compra.";
        add.textContent = "Agregado";
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => { add.textContent = "Agregar"; }, 1200);
      }, "add");
      add.setAttribute("aria-label", "Agregar " + product.name);
      row.append(media, el("h4", product.name), prices, add);
      results.append(row);
    }
  }
}

function renderPromotionCatalog(catalog) {
  const root = find("#promotion-stores");
  const status = find("#promotion-status");
  if (!root || !status) return;
  root.replaceChildren();
  const storesWithResults = (catalog || []).filter((entry) => Array.isArray(entry.categories));
  const failed = (catalog || []).filter((entry) => entry.error).map((entry) => entry.store);
  if (!storesWithResults.length && !failed.length) {
    status.textContent = "No pudimos cargar los folletos. Volvé a intentarlo más tarde.";
    return;
  }
  status.textContent = failed.length
    ? "No se pudo cargar el catálogo de " + failed.join(", ") + "."
    : "Promociones agrupadas por supermercado y categoría.";
  for (const entry of storesWithResults) {
    const section = el("section", undefined, "promotion-store-section");
    section.append(el("h3", entry.store, "promotion-store-title"));
    if (!entry.categories.length) {
      section.append(el("p", "La tienda no informó promociones de productos en su catálogo.", "muted"));
    }
    for (const category of entry.categories) {
      const group = el("section", undefined, "promotion-category");
      group.append(el("h4", category.name + " (" + category.products.length + ")"));
      const grid = el("div", undefined, "promotion-list");
      for (const offer of category.products) {
        const card = el("article", undefined, "promotion-card");
        card.append(el("h5", offer.name));
        card.append(el("strong", "Precio publicado: " + fmt(offer.price), "promotion-price"));
        const tags = el("ul", undefined, "promotion-tags");
        for (const label of offer.promos) tags.append(el("li", label));
        card.append(tags);
        const link = el("a", "Ver producto en la tienda");
        link.href = offer.link;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
        grid.append(card);
      }
      group.append(grid);
      section.append(group);
    }
    root.append(section);
  }
  for (const store of failed) {
    const section = el("section", undefined, "promotion-store-section");
    section.append(el("h3", store, "promotion-store-title"));
    const message = store === "Carrefour"
      ? "El catálogo completo de promociones de Carrefour no está disponible ahora."
      : "No pudimos cargar el catálogo de promociones.";
    section.append(el("p", message, "muted"));
    root.append(section);
  }

}

async function loadPromotionCatalog() {
  const status = find("#promotion-status");
  if (!status) return;
  status.textContent = "Cargando promociones…";
  try {
    const response = await fetch("/api/promotions", {signal: AbortSignal.timeout(45000)});
    const data = await response.json();
    renderPromotionCatalog(data.stores || []);
  } catch {
    status.textContent = "No pudimos cargar los folletos. Volvé a intentarlo más tarde.";
  }
}

function resetQuote() {
  basketRevision++;
  recommended = null;
  find("#scenarios").replaceChildren();
  find("#quote-status").textContent = "";
  renderBasket();
}

function renderBasket() {
  const lists = find("#lists");
  const focus = lists.contains(document.activeElement) ? document.activeElement.dataset : null;
  const byStore = new Map(stores.map((store) => [store, []]));
  let grandTotal = 0;
  for (const [key, item] of basket) {
    const lines = recommended ? recommended.lines.filter((line) => line.key === key) : allocation(item.offers, item.quantity);
    for (const line of lines) {
      byStore.get(line.product.store).push({...line, key});
      grandTotal += line.total;
    }
  }
  find("#total").textContent = fmt(recommended?.net ?? grandTotal);
  const units = [...basket.values()].reduce((sum, item) => sum + item.quantity, 0);
  find("#nav-count").textContent = units;
  find(".basket-link").setAttribute("aria-label", "Tu compra: " + units + (units === 1 ? " unidad" : " unidades"));
  find("#basket-label").textContent = recommended ? "Costo final estimado" : "Subtotal de productos";
  find("#basket-caption").textContent = recommended ? "Con envío cotizado; sin cupones ni beneficios bancarios." :
    basket.size ? "Antes de cotizar el envío." : "Agregá productos para cotizar tu lista.";
  find("#quote").disabled = !basket.size || find("#quote").getAttribute("aria-busy") === "true";
  lists.replaceChildren();
  for (const [store, lines] of byStore) {
    if (!lines.length) continue;
    const section = el("section", undefined, "store");
    const heading = el("div", undefined, "heading");
    heading.append(el("h3", store), el("strong", fmt(lines.reduce((sum, line) => sum + line.total, 0))));
    section.append(heading);
    for (const line of lines) {
      const row = el("div", undefined, "line");
      const title = el("div", undefined, "heading");
      const name = el("a", line.quantity + " × " + line.product.name);
      name.href = line.product.link;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
      title.append(name, el("strong", fmt(line.total), "subtotal"));
      row.append(title);
      if (line.promo) row.append(el("div", line.promo, "promo"));
      const controls = el("div", undefined, "controls");
      const minus = button("−", () => changeQuantity(line.key, -1));
      minus.setAttribute("aria-label", "Quitar una unidad de " + line.product.name);
      const plus = button("+", () => changeQuantity(line.key, 1));
      plus.setAttribute("aria-label", "Sumar una unidad de " + line.product.name);
      for (const [control, action] of [[minus, "minus"], [plus, "plus"]]) {
        Object.assign(control.dataset, {key: line.key, store, action});
      }
      plus.disabled = basket.get(line.key).quantity >= 99;
      controls.append(minus, el("span", basket.get(line.key).quantity + " en total", "muted"), plus);
      row.append(controls);
      section.append(row);
    }
    const copy = button("Copiar lista", async () => {
      try {
        await navigator.clipboard.writeText(lines.map((line) => line.quantity + " × " + line.product.name).join("\n"));
        copy.textContent = "Lista copiada";
      } catch {
        copy.textContent = "No se pudo copiar";
      }
    }, "copy");
    section.append(copy);
    lists.append(section);
  }
  if (focus?.action) {
    const controls = [...lists.querySelectorAll(".controls button:not(:disabled)")];
    const sameItem = controls.filter((control) => control.dataset.key === focus.key);
    const next = sameItem.find((control) => control.dataset.action === focus.action && control.dataset.store === focus.store)
      || sameItem.find((control) => control.dataset.action === focus.action) || sameItem[0] || controls[0] || find("#compra");
    next.focus({preventScroll: true});
  }
}

find("#suggestions").addEventListener("click", (event) => {
  const suggestion = event.target.closest("button[data-query]");
  if (!suggestion || find("#search button").disabled) return;
  find("#query").value = suggestion.dataset.query;
  find("#query").focus({preventScroll: true});
  find("#search").requestSubmit(find("#search button"));
});

find("#search").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (find("#search button").disabled) return;
  const terms = [...new Set(find("#query").value.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean))];
  if (!terms.length || terms.length > 6 || terms.some((term) => term.length < 2 || term.length > 100)) {
    status.dataset.state = "warning";
    status.textContent = "Ingresá hasta 6 búsquedas separadas por comas, de 2 a 100 caracteres cada una.";
    return;
  }
  const submit = event.submitter || find("#search button");
  submit.disabled = true;
  find("#suggestions").hidden = true;
  status.dataset.state = "loading";
  results.setAttribute("aria-busy", "true");
  status.textContent = "Consultando Monarca y Carrefour…";
  try {
    const responses = await Promise.all(terms.map(async (term) => {
      try {
        const response = await fetch("/api/search?" + new URLSearchParams({q: term}), {signal: AbortSignal.timeout(24000)});
        const data = await response.json();
        return {term, groups: groupProducts(data.products || []), errors: data.errors || []};
      } catch {
        return {term, groups: [], errors: stores};
      }
    }));
    groupsByTerm = responses;
    const missing = responses.filter((response) => response.errors.length);
    const count = new Set(responses.flatMap((response) => response.groups.map(([key]) => key))).size;
    status.dataset.state = missing.length ? "warning" : "";
    status.textContent = missing.length
      ? "Consulta incompleta. Reintentá: " + missing.map((item) => item.term + " (" + item.errors.join(" y ") + ")").join(", ") + "."
      : count ? "Elegí la marca y el tamaño que querés agregar." : "No encontramos productos para esa búsqueda.";
    find("#count").textContent = count + (count === 1 ? " producto" : " productos");
    for (const {groups} of responses) {
      for (const [key, offers] of groups) {
        if (basket.has(key) && offers.length >= basket.get(key).offers.length) basket.get(key).offers = offers;
      }
    }
    save();
    renderResults();
    resetQuote();
  } finally {
    submit.disabled = false;
    results.removeAttribute("aria-busy");
  }
});

renderBasket();

loadPromotionCatalog();
