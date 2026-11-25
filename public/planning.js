"use strict";

const quoteButton = find("#quote");
const quoteStatus = find("#quote-status");
const postalInput = find("#postal");
const purchaseDate = find("#purchase-date");
const tandilDate = new Intl.DateTimeFormat("sv-SE", {timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short"});
const today = () => tandilDate.format(new Date());
purchaseDate.value = today();
purchaseDate.min = today();

function displayDate(iso) {
  return iso.split("-").reverse().join("/");
}

function summarize(lines, shipping) {
  const products = lines.reduce((sum, line) => sum + line.total, 0);
  const pay = products + shipping;
  return {pay, refund: 0, net: pay};
}

function summarize(lines, shipping) {
  const products = lines.reduce((sum, line) => sum + line.total, 0);
  const pay = products + shipping;
  return {pay, refund: 0, net: pay};
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
    return {name: "Reparto alternativo", lines, net: summarize(lines, 0).net};
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
  return {...plan, lines, shipping, deliveryDate, ...summarize(lines, shipping)};
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
    ["Productos", fmt(chosen.pay - chosen.shipping)],
    ["Envío estimado", fmt(chosen.shipping)],
    ["Costo final estimado", fmt(chosen.net), "plan-final"],
  ]) {
    const row = el("div", undefined, className);
    row.append(el("dt", label), el("dd", value));
    totals.append(row);
  }
  breakdown.append(totals);
  if (chosen.deliveryDate) breakdown.append(el("p", "Carrefour cotizado para una franja del " + displayDate(tandilDate.format(new Date(chosen.deliveryDate))) + ".", "muted"));
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
