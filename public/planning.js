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

function savePlanning() {
  try {
    localStorage.setItem("changuito-benefits", JSON.stringify(benefits));
  } catch {
    // The current session still works without storage.
  }
}

function displayDate(iso) {
  return iso.split("-").reverse().join("/");
}

function showBenefits(focusIndex) {
  const list = find("#benefit-list");
  list.replaceChildren();
  if (!benefits.length) {
    list.append(el("p", "Todavía no cargaste beneficios.", "muted"));
    if (focusIndex !== undefined) find("#add-benefit").focus();
    return;
  }
  const items = el("ul", undefined, "benefit-items");
  benefits.forEach((rule, index) => {
    const line = el("li", undefined, "benefit-item");
    const details = el("div", undefined, "benefit-details");
    const day = rule.day === "" ? "Todos los días" : weekdays[Number(rule.day)];
    const type = rule.kind === "refund" ? "reintegro" : "descuento inmediato";
    const cap = rule.cap === null ? "Sin tope cargado" : "Tope " + fmt(rule.cap);
    const minimum = rule.minimum ? "Compra mínima " + fmt(rule.minimum) : "Sin mínimo";
    details.append(
      el("strong", rule.name + " · " + rule.store),
      el("p", rule.percent + "% de " + type + " · " + day),
      el("p", [displayDate(rule.start) + " al " + displayDate(rule.end), minimum, cap,
        rule.stack ? "Acumula con promos" : "No acumula con promos"].join(" · "), "muted")
    );
    const remove = button("Quitar", () => {
      benefits.splice(index, 1);
      savePlanning();
      showBenefits(index);
      resetQuote();
    }, "benefit-remove");
    remove.setAttribute("aria-label", "Quitar beneficio " + (index + 1) + ": " + rule.name + " en " + rule.store);
    line.append(details, remove);
    items.append(line);
  });
  list.append(items);
  if (focusIndex !== undefined) {
    items.children[Math.min(focusIndex, items.children.length - 1)].querySelector("button").focus();
  }
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

function showPlans(plans, chosen, date, keepFocus = false) {
  recommended = chosen;
  renderBasket();
  const section = find("#scenarios");
  section.replaceChildren();
  const options = el("div", undefined, "plan-options");
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", "Alternativas cotizadas");
  for (const plan of plans) {
    const option = button(undefined, () => showPlans(plans, plan, date, true), "scenario");
    option.append(el("span", plan.name, "scenario-name"), el("strong", fmt(plan.net), "scenario-price"));
    if (plans.length > 1 && plan.net === plans[0].net) {
      option.append(el("span", "Menor costo cotizado", "scenario-note"));
    }
    option.setAttribute("aria-pressed", plan === chosen);
    option.setAttribute("aria-controls", "plan-breakdown");
    options.append(option);
  }
  const breakdown = el("div");
  breakdown.id = "plan-breakdown";
  const totals = el("dl", undefined, "plan-totals");
  for (const [label, value, className] of [
    ["Día comparado", displayDate(date)],
    ["Envío estimado", fmt(chosen.shipping)],
    ["Pagás al comprar", fmt(chosen.pay)],
    ["Recuperás después", fmt(chosen.refund)],
    ["Costo final estimado", fmt(chosen.net), "plan-final"],
  ]) {
    const row = el("div", undefined, className);
    row.append(el("dt", label), el("dd", value));
    totals.append(row);
  }
  breakdown.append(totals);
  if (chosen.deliveryDate) breakdown.append(el("p", "Carrefour cotizado para una franja del " + displayDate(tandilDate.format(new Date(chosen.deliveryDate))) + ".", "muted"));
  for (const rule of chosen.applied) breakdown.append(el("p", rule.store + " · " + rule.name + " · " + fmt(rule.amount), "promo"));
  section.append(options, breakdown);
  if (keepFocus) options.querySelector('[aria-pressed="true"]').focus({preventScroll: true});
}

quoteButton.addEventListener("click", async () => {
  const postalCode = "7000"; // CP interno de Tandil para la cotización de Carrefour.
  const date = purchaseDate.value;
  if (!basket.size || !date || date < today()) {
    quoteStatus.textContent = "Agregá productos y revisá el día.";
    return;
  }
  savePlanning();
  resetQuote();
  const revision = basketRevision;
  const candidates = cartCandidates(date);
  const cache = new Map();
  quoteButton.setAttribute("aria-busy", "true");
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
    quoteButton.removeAttribute("aria-busy");
    quoteButton.disabled = !basket.size;
  }
});

postalInput.addEventListener("change", resetQuote);
purchaseDate.addEventListener("change", resetQuote);
showBenefits();
