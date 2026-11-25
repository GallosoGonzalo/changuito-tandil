# Cambios

## 2026-11-24 · Tipografía

Los títulos y la marca usan [Bricolage Grotesque](https://github.com/google/fonts/tree/main/ofl/bricolagegrotesque) en lugar de Georgia. «Tandil» conserva el verde claro y deja de ir en cursiva. Los párrafos, formularios y precios usan la tipografía del sistema. La fuente se sirve localmente, sin solicitudes a terceros, con [licencia SIL Open Font License](../public/fonts/OFL-bricolage-grotesque.txt).

Se verificó que la fuente cargue en Chrome de 320 a 1440 px y que el título no choque con la ilustración. Las capturas muestran la versión con la tipografía actual.

## 2026-11-24 · Búsqueda, changuito y cotización

Revisión del comparador original con Impeccable. Se mantienen el verde y el crema, los títulos serif, el español rioplatense y la lógica de precios. No se agregan dependencias al sitio.

| En la versión anterior | Qué cambió |
| --- | --- |
| Antes de buscar, «Productos» dejaba casi toda la columna vacía; el changuito repetía un total de cero y dos subtotales de cero. | Se puede empezar con una búsqueda escrita o sugerida. El changuito vacío muestra un único subtotal, explica cómo seguir y habilita la cotización cuando hay productos. |
| El lector tenía que separar mentalmente el comercio, el importe y las promos de cada resultado. | Los nombres e importes ocupan posiciones consistentes. Si falta la foto, se muestra un ícono neutral en vez de una imagen rota. |
| En el teléfono, después de una búsqueda larga había que atravesar todo el catálogo para volver a la compra. | La cabecera mantiene a mano el acceso al changuito y muestra cuántas unidades tiene. |
| El foco del teclado se perdía al ajustar cantidades o cambiar de alternativa. | Los controles conservan el foco. El desglose distingue la alternativa elegida del menor costo cotizado, incluso si hay empate. |

La ilustración de la canasta y los íconos son originales y se sirven localmente. El fondo crema, señalado por el detector de Impeccable como un patrón frecuente, se conserva deliberadamente: forma parte de la identidad anterior.

**Evidencia visual:** [antes en escritorio](capturas/escritorio-antes.png), [ahora en escritorio](capturas/escritorio.png) y [ahora en móvil](capturas/movil.png). Las capturas muestran el estado inicial, sin datos ficticios de precios.

**Verificación:** recorrido en Chrome a 320, 390, 820 y 1440 px con respuestas controladas para ambos supermercados: búsqueda múltiple, consulta parcial y sin resultados, cantidad, persistencia, beneficios, alternativas y copia de la lista. Se revisaron el foco de teclado y el desborde horizontal. axe-core no detectó infracciones en los estados vacío y cotizado evaluados en móvil y escritorio; esto no reemplaza una auditoría manual con tecnologías de asistencia. Se comprobó por separado que una búsqueda real de «yerba» desde el servidor local devolviera resultados de ambas tiendas; no se realizó una compra ni se certificaron precios o stock.
