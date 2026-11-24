const {test, expect} = require("@playwright/test");

// Iniciar app.py por separado. Las únicas respuestas de supermercados son fixtures.
const baseURL = process.env.BASE_URL || "http://127.0.0.1:8000";
const name = "Yerba de prueba · 1 kg";
function offer(store, id, price) {
  return {store, id, seller: "1", price, name, ean: "07790000000003",
    image: null, promos: [], link: "https://example.invalid/producto"};
}

test.use({baseURL, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires"});
for (const width of [360, 1440]) {
  test.describe(`Compra a ${width}px`, () => {
    test.use({viewport: {width, height: 900}});
    test("busca, ajusta cantidades, compara costos y conserva la lista", async ({page}) => {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/search?*", route => route.fulfill({json: {
        products: [offer("Monarca", "101", 1200000), offer("Carrefour", "202", 1100000)], errors: [],
      }}));
      let quoteRequest;
      await page.route("**/api/quote", route => {
        quoteRequest = route.request().postDataJSON();
        return route.fulfill({json: {available: true, shipping: 200000, starts: null,
          lines: quoteRequest.items.map(item => ({total: 1100000 * item.quantity, discount: false}))}});
      });

      await page.goto("/");
      const quote = page.getByRole("button", {name: "Cotizar y comparar"});
      await expect(quote).toBeDisabled();
      await page.getByRole("button", {name: "Buscar yerba", exact: true}).press("Enter");
      await expect(page.locator("#results article")).toHaveCount(1); // Un mismo código en dos tiendas.
      await page.getByRole("button", {name: "Agregar " + name, exact: true}).press("Enter");
      const plus = page.getByRole("button", {name: "Sumar una unidad de " + name});
      await plus.press("Enter");
      await expect(plus).toBeFocused();
      await expect(page.locator("#nav-count")).toHaveText("2");
      await page.getByRole("button", {name: "Quitar una unidad de " + name}).press("Enter");

      await quote.press("Enter");
      const chosen = page.locator("#scenarios [aria-pressed=true]");
      await expect(chosen).toContainText("Todo en Monarca");
      expect(quoteRequest).toEqual({postalCode: "7000", items: [{id: "202", seller: "1", quantity: 1}]});
      const other = page.locator("#scenarios [aria-pressed=false]");
      await other.press("Enter");
      await expect(chosen).toBeFocused();
      await expect(page.locator("#basket-label")).toHaveText("Costo final estimado");
      await expect(page.locator("#total")).toHaveText(/13\.000,00/); // Carrefour + envío.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.reload();
      await expect(page.locator("#nav-count")).toHaveText("1");
      await expect(page.locator("#total")).toHaveText(/11\.000,00/); // Subtotal guardado, no cotización vencida.
      await page.getByRole("button", {name: "Quitar una unidad de " + name}).press("Enter");
      await expect(page.locator("#compra")).toBeFocused();
      await expect(quote).toBeDisabled();
      expect(errors).toEqual([]);
    });
  });
}
