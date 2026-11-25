# Changuito Tandil

Comparador de Monarca y Carrefour. Buscá uno o varios productos separados por comas, elegí una presentación y ajustá las cantidades. Se compara el mismo producto cuando ambas tiendas devuelven el mismo código de barras. La compra se confirma manualmente en cada tienda.

## Cómo abrirlo

1. Cloná este repositorio o descomprimí el ZIP.
2. En la carpeta `changuito-tandil`, ejecutá `python3 app.py`.
3. Abrí http://localhost:8000.

Requiere Python 3.10 o superior e internet. Si querés abrirlo desde el celular en tu red local, iniciá `python3 app.py --host 0.0.0.0` y abrí `http://IP-DE-TU-PC:8000` desde el celular conectado al mismo Wi-Fi. Para copiar la lista desde otra máquina, el navegador puede exigir HTTPS.

## Cómo comparar

1. Escribí hasta seis búsquedas separadas por comas o tocá **Yerba**, **Leche** o **Detergente** para hacer una consulta al catálogo. Las sugerencias no son precios de muestra.
2. Compará los precios de la misma presentación y elegí **Agregar**. **Tu compra**, en la barra superior, muestra la cantidad de unidades y te lleva a la lista. Podés sumar o quitar unidades y copiar la lista por supermercado.
3. Si tenés un beneficio, cargalo en **Beneficios**. Elegí el día de compra y **Cotizar y comparar**. El subtotal del catálogo no es el importe final: cuando hay cotización se separan el envío estimado y el costo final. Cambiá de alternativa para ver su desglose.

[Vista de escritorio](docs/capturas/escritorio.png) · [Vista móvil](docs/capturas/movil.png) · [Cambios y verificación visual](docs/CHANGELOG.md)

## Precios, envío y promociones

- Agregá productos al changuito y elegí **Cotizar y comparar**. El código postal inicial es 7000. Carrefour se cotiza por SKU, vendedor y cantidad para ese código postal. La cotización usa el total por producto de la simulación y el precio de una franja de entrega común. Si no hay una franja con precio verificable o falta stock, esa opción queda fuera. Se usa el mínimo de compra publicado de $10.000 para la app Carrefour. Para Monarca se toma el envío bonificado publicado para Tandil.
- Monarca calcula descuentos directos, segunda unidad y 3×2 cuando la API informa los datos necesarios. Carrefour muestra los descuentos incluidos por la simulación. Las promos informadas por catálogo se muestran como referencia.
- La sección **Productos en promo** reúne las ofertas del catálogo para los productos encontrados en tus búsquedas. Abrí el enlace del producto para confirmar condiciones y vigencia en la tienda.
- Podés elegir un día futuro para comparar promociones por producto con los precios y el envío cotizados hoy. La app compara hasta cuatro repartos, incluyendo todo en un supermercado cuando hay oferta para todos los productos. El resultado es la mejor alternativa de las cotizadas.
- La lista se guarda en el navegador. Volvé a buscar para actualizar los precios de catálogo y cotizá antes de comprar. Confirmá la disponibilidad, el envío y las promociones en la app de cada supermercado.

## Prueba de interfaz (opcional)

Con el servidor local iniciado, la [prueba de compra](tests/compra.spec.cjs) recorre búsqueda, cantidades, cotización y persistencia a 360 y 1440 px. Intercepta las respuestas de las tiendas para que el resultado no dependa del precio del día. No hace falta instalar Node ni Playwright para usar la aplicación.

Para probarla en macOS o Linux con Node/npm y Google Chrome ya instalados, ejecutá desde la raíz:

```sh
QA=$(mktemp -d)
npm install --prefix "$QA" @playwright/test@1.63.0
NODE_PATH="$QA/node_modules" PLAYWRIGHT_CHANNEL=chrome BASE_URL=http://127.0.0.1:8000 \
  "$QA/node_modules/.bin/playwright" test tests/compra.spec.cjs --output="$QA/results" --workers=1
```

Si usás Chromium de Playwright en lugar de Chrome, ejecutá `"$QA/node_modules/.bin/playwright" install chromium` y omití `PLAYWRIGHT_CHANNEL=chrome`.

## Vercel

Desde la carpeta del proyecto, ejecutá `npx vercel login` y después `npx vercel --prod`. También podés importar un repositorio que contenga estos archivos desde el panel de Vercel. La interfaz se sirve desde `public/` y las tiendas se consultan mediante las funciones `/api/search` y `/api/quote`. No requiere credenciales de los supermercados ni variables de entorno.
