"use strict";

const benefitForm = find("#benefit-form");
const quoteButton = find("#quote");
const quoteStatus = find("#quote-status");
const postalInput = find("#postal");
const purchaseDate = find("#purchase-date");
const benefits = readSaved("changuito-benefits", []);
const weekdays = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const tandilDate = new Intl.DateTimeFormat("sv-SE", {timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short"});
const today = () => tandilDate.format(new Date());
purchaseDate.value = today();
purchaseDate.min = today();
postalInput.value = readSaved("changuito-postal", "7000");

function savePlanning() {
  try {
    localStorage.setItem("changuito-benefits", JSON.stringify(benefits));
    localStorage.setItem("changuito-postal", JSON.stringify(postalInput.value));
  } catch {
    // The current session still works without storage.
  }
}

function showBenefits() {
  const list = find("#benefit-list");
  list.replaceChildren();
  if (!benefits.length) list.append(el("p", "Todavía no cargaste beneficios.", "muted"));
  benefits.forEach((rule, index) => {
    const line = el("div", undefined, "line heading");
    const day = rule.day === "" ? "Todos los días" : weekdays[Number(rule.day)];
    const cap = rule.cap === null ? "sin tope cargado" : "tope " + fmt(rule.cap);
    line.append(el("span", [rule.store, rule.name, day, rule.percent + "%", cap, rule.start + " a " + rule.end].join(" · ")));
    line.append(button("Quitar", () => {
      benefits.splice(index, 1);
      savePlanning();
      showBenefits();
      resetQuote();
    }));
    list.append(line);
  });
}

benefitForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(benefitForm);
  const start = fields.get("start");
  const end = fields.get("end");
  const name = fields.get("name").trim();
  const status = find("#benefit-status");
  if (!name || end < start) {
    status.textContent = "Ingresá el medio de pago y revisá las fechas.";
    return;
  }
  const cap = fields.get("cap");
  benefits.push({
    name, start, end,
    store: fields.get("store"), day: fields.get("day"), kind: fields.get("kind"),
    percent: Number(fields.get("percent")), cap: cap === "" ? null : Math.round(Number(cap) * 100),
    minimum: Math.round(Number(fields.get("minimum")) * 100), stack: fields.has("stack"),
  });
  savePlanning();
  showBenefits();
  resetQuote();
  benefitForm.reset();
  status.textContent = "Beneficio guardado. Volvé a cotizar para aplicarlo.";
});

function bestBenefit(store, subtotal, hasPromo, date) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  let best = {amount: 0};
  for (const rule of benefits) {
    if (rule.store !== store || date < rule.start || date > rule.end ||
        (rule.day !== "" && Number(rule.day) !== day) || subtotal < rule.minimum ||
        (hasPromo && !rule.stack)) continue;
    const amount = Math.min(rule.cap ?? Infinity, Math.round(subtotal * rule.percent / 100));
    if (amount > best.amount || (amount && amount === best.amount && rule.kind === "discount")) {
      best = {...rule, amount};
    }
  }
  return best;
}

function summarize(lines, shipping, date) {
  let pay = shipping;
  let refund = 0;
  const applied = [];
  for (const store of stores) {
    const storeLines = lines.filter((line) => line.product.store === store);
    if (!storeLines.length) continue;
    const subtotal = storeLines.reduce((sum, line) => sum + line.total, 0);
    pay += subtotal;
    const rule = bestBenefit(store, subtotal, storeLines.some((line) => line.promo), date);
    if (!rule.amount) continue;
    applied.push(rule);
    if (rule.kind === "refund") refund += rule.amount;
    else pay -= rule.amount;
  }
  return {pay, refund, net: pay - refund, applied};
}

function cartCandidates(date) {
  const entries = [...basket];
  const at = date === today() ? Date.now() : Date.parse(date + "T12:00:00-03:00");
  const split = entries.flatMap(([key, item]) =>
    allocation(item.offers, item.quantity, at).map((line) => ({...line, key})));
  const asStore = (key, item, store) => {
    const product = item.offers.find((offer) => offer.store === store);
    return product && {key, product, quantity: item.quantity, ...priceFor(product, item.quantity, at)};
  };
  const plans = [
    {name: "Compra repartida", lines: split},
    ...stores.map((store) => ({
      name: "Todo en " + store,
      lines: entries.map(([key, item]) => asStore(key, item, store)),
    })),
  ];
  const alternative = entries.flatMap(([key, item]) => stores.map((store) => {
    const line = asStore(key, item, store);
    if (!line || item.offers.length < 2) return null;
    const lines = split.filter((entry) => entry.key !== key).concat(line);
    return {name: "Reparto alternativo", lines, net: summarize(lines, 0, date).net};
  })).filter(Boolean).sort((a, b) => a.net - b.net);
  const seen = new Set();
  return [...plans, ...alternative].filter(({lines}) => {
    if (lines.includes(null)) return false;
    const key = JSON.stringify(lines.map((line) => [line.product.store, line.product.id, line.quantity]).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

async function quotePlan(plan, postalCode, date, quoteCache) {
  const lines = plan.lines.map((line) => ({...line}));
  const carrefour = lines.filter((line) => line.product.store === "Carrefour");
  let shipping = 0;
  let deliveryDate = null;
  if (carrefour.length) {
    const items = carrefour.map((line) => ({
      id: line.product.id, seller: line.product.seller ?? "1", quantity: line.quantity,
    }));
    const key = JSON.stringify(items);
    if (!quoteCache.has(key)) {
      quoteCache.set(key, fetch("/api/quote", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({items, postalCode}), signal: AbortSignal.timeout(22000),
      }).then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      }).catch(() => null));
    }
    const quote = await quoteCache.get(key);
    if (!quote?.available || quote.shipping === null || quote.lines?.length !== carrefour.length) return null;
    shipping = quote.shipping;
    deliveryDate = quote.starts;
    for (const [index, line] of carrefour.entries()) {
      line.total = quote.lines[index].total;
      line.promo = quote.lines[index].discount ? "Descuento incluido en cotización" : null;
    }
    const subtotal = carrefour.reduce((sum, line) => sum + line.total, 0);
    if (subtotal < 1000000) return null;
  }
  return {...plan, lines, shipping, deliveryDate, ...summarize(lines, shipping, date)};
}

function showPlans(plans, chosen, date) {
  recommended = chosen;
  renderBasket();
  const section = find("#scenarios");
  section.replaceChildren();
  for (const plan of plans) {
    const option = button(plan.name + " · " + fmt(plan.net), () => showPlans(plans, plan, date), "scenario");
    option.setAttribute("aria-pressed", plan === chosen);
    section.append(option);
  }
  const totals = el("div", undefined, "plan-totals");
  totals.append(
    el("p", "Día comparado: " + date.split("-").reverse().join("/")),
    el("p", "Envío estimado: " + fmt(chosen.shipping)),
    el("p", "Pagás al comprar: " + fmt(chosen.pay)),
    el("p", "Recuperás después: " + fmt(chosen.refund)),
    el("p", "Costo final estimado: " + fmt(chosen.net)),
  );
  if (chosen.deliveryDate) totals.append(el("p", "Carrefour cotizado para una franja del " + tandilDate.format(new Date(chosen.deliveryDate)) + ".", "muted"));
  for (const rule of chosen.applied) totals.append(el("p", rule.store + " · " + rule.name + " · " + fmt(rule.amount), "promo"));
  section.append(totals);
}

quoteButton.addEventListener("click", async () => {
  const postalCode = postalInput.value.trim().toUpperCase();
  const date = purchaseDate.value;
  if (!basket.size || !date || date < today() || !/^(?:\d{4}|[A-Z]\d{4}[A-Z]{3})$/.test(postalCode)) {
    quoteStatus.textContent = "Agregá productos y revisá el código postal y el día.";
    return;
  }
  savePlanning();
  resetQuote();
  const revision = basketRevision;
  const candidates = cartCandidates(date);
  const cache = new Map();
  quoteButton.disabled = true;
  quoteStatus.textContent = "Cotizando la compra a domicilio…";
  try {
    const quotes = await Promise.all(candidates.map((plan) => quotePlan(plan, postalCode, date, cache)));
    if (revision !== basketRevision) return;
    const plans = quotes.filter(Boolean).sort((a, b) => a.net - b.net);
    const incomplete = plans.length !== candidates.length;
    quoteStatus.textContent = plans.length
      ? (incomplete ? "Algunos repartos quedaron afuera por mínimo, stock o envío sin cotizar." : "Ordenado por costo final estimado.")
      : "No se pudo cotizar un reparto completo. Revisá el stock, el mínimo o el envío de Carrefour.";
    if (plans.length) showPlans(plans, plans[0], date);
  } finally {
    quoteButton.disabled = false;
  }
});

postalInput.addEventListener("input", resetQuote);
purchaseDate.addEventListener("change", resetQuote);
showBenefits();
