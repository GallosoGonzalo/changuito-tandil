# Changuito Tandil

Comparador de Monarca y Carrefour. Buscá uno o varios productos separados por comas, elegí una presentación y ajustá las cantidades. Se compara el mismo producto cuando ambas tiendas devuelven el mismo código de barras. La compra se confirma manualmente en cada tienda.

## Cómo abrirlo

1. Descomprimí el ZIP.
2. En la carpeta `changuito-tandil`, ejecutá `python3 app.py`.
3. Abrí http://localhost:8000.

Requiere Python 3.10 o superior e internet. Si querés abrirlo desde el celular en tu red local, iniciá `python3 app.py --host 0.0.0.0` y abrí `http://IP-DE-TU-PC:8000` desde el celular conectado al mismo Wi-Fi. Para copiar la lista desde otra máquina, el navegador puede exigir HTTPS.

## Precios, envío y promociones

- Agregá productos al changuito y elegí **Cotizar y comparar**. El código postal inicial es 7000. Carrefour se cotiza por SKU, vendedor y cantidad para ese código postal. La cotización usa el total por producto de la simulación y el precio de una franja de entrega común. Si no hay una franja con precio verificable o falta stock, esa opción queda fuera. Se usa el mínimo de compra publicado de $10.000 para la app Carrefour. Para Monarca se toma el envío bonificado publicado para Tandil.
- Monarca calcula descuentos directos, segunda unidad y 3×2 cuando la API informa los datos necesarios. Carrefour muestra los descuentos incluidos por la simulación. Las promos informadas por catálogo se muestran como referencia.
- En **Calendario de beneficios** cargá tarjetas o billeteras que usás, con la vigencia, día, porcentaje, mínimo, tope restante y acumulación. El cálculo aplica un beneficio por supermercado sobre el subtotal de productos. Cargá solo beneficios que correspondan al pedido a domicilio completo. El monto pagado y el reintegro aparecen por separado.
- Podés elegir un día futuro para comparar beneficios con los precios y el envío de hoy. La app compara hasta cuatro repartos, incluyendo todo en un supermercado cuando hay oferta para todos los productos. El resultado es la mejor alternativa de las cotizadas.
- La lista y tus beneficios se guardan en el navegador. Volvé a buscar para actualizar los precios de catálogo y cotizá antes de comprar. Confirmá la disponibilidad, el envío y las promociones en la app de cada supermercado.

## Vercel

Desde la carpeta del proyecto, ejecutá `npx vercel login` y después `npx vercel --prod`. También podés importar un repositorio que contenga estos archivos desde el panel de Vercel. La interfaz se sirve desde `public/` y las tiendas se consultan mediante las funciones `/api/search` y `/api/quote`. No requiere credenciales de los supermercados ni variables de entorno.
