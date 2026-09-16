# Control de frecuencia del transporte público urbano

Aplicación web de operación para una flota simulada de **310 buses sobre 22 rutas**. Reconstruye posiciones a partir de GPS ruidoso, mantiene los buses ordenados por avance, anticipa agrupamientos (*bunching*), detecta huecos de servicio y propone acciones de regulación.

La demostración funciona completamente en el navegador y no depende de servicios externos. La cartografía es sintética y determinística porque el archivo estático de 6 MB mencionado en el enunciado no fue suministrado. El módulo cartográfico está aislado para poder sustituirla por el archivo original sin cambiar la interfaz ni el procesamiento.

## Demostración rápida

1. Abra la URL desplegada y espere a que aparezca **“Simulación lista: 310 buses conectados”**.
2. Pulse **Forzar agrupamiento**. Si hay una ruta seleccionada, el escenario se crea en esa ruta; de lo contrario se usa R-07.
3. En pocos segundos aparecerá una alerta con intervalo proyectado, confianza y recomendación de retención.
4. Pulse **Registrar acción** para guardar la actuación del supervisor.
5. Use el control inferior para retroceder hasta dos horas sin consultar al servidor.
6. Abra **Ver diagnóstico técnico** para comprobar Workers, memoria compartida, prueba de calles paralelas e instrumentación de rendimiento.

## Ejecución local

La aplicación es estática. Debe servirse por HTTP para habilitar Workers y Service Worker:

```bash
cd dist
python -m http.server 8080
```

Luego abra `http://localhost:8080`. La primera apertura puede recargarse una vez para activar el aislamiento requerido por `SharedArrayBuffer`.

La prueba algorítmica se ejecuta con:

```bash
node tests/map-matching.test.mjs
```

Resultado esperado:

```text
Prueba aprobada: vecino más cercano=18; memoria de secuencia=0.
```

## Despliegue en Vercel

El repositorio incluye `vercel.json`, que publica directamente la carpeta `dist/` y configura los encabezados COOP, COEP y CORP requeridos por `SharedArrayBuffer`.

1. Importe este repositorio en Vercel.
2. Mantenga el framework como **Other**.
3. No es necesario configurar comandos de instalación ni compilación.
4. Vercel tomará `dist/` como directorio de salida y realizará el despliegue.

## Flujo de una posición GPS

```text
Mensaje GPS ruidoso
        ↓
Validación temporal y descarte de mensajes fuera de orden
        ↓
Consulta del índice espacial uniforme
        ↓
Candidatos punto-segmento y proyección sobre la polilínea
        ↓
Asignación secuencial mediante ventana móvil y programación dinámica
        ↓
Posición monótona en metros sobre la ruta
        ↓
Orden dinámico de buses, proyección de intervalos y detección temprana
        ↓
Recomendación de retención y resolución de capacidad del paradero
        ↓
Canvas del centro de control + registro offline del supervisor
```

## Cumplimiento funcional

| Requisito | Implementación |
|---|---|
| RF-1 · Búsqueda espacial | Rejilla uniforme de celdas sobre 40.040 vértices. La consulta visita únicamente la celda de la medición y sus vecinas. |
| RF-2 · Asignación a vía | Costo de emisión por distancia y costo de transición por avance, retroceso y distancia esperada, resuelto sobre una ventana de 5 observaciones y máximo 10 candidatos. |
| RF-3 · Posición monótona | Proyección punto-segmento, progreso normalizado y rechazo de marcas de tiempo antiguas. Los silencios quedan marcados como estado estimado. |
| RF-4 · Tiempos por tramo | Histogramas acotados de 48 cubetas por ruta y tramo; permiten obtener mediana y percentil 85 sin conservar observaciones individuales. |
| RF-5 · Intervalos | Ordenamiento por progreso de cada ruta, comparación con la frecuencia programada y alertas cuando el intervalo cae bajo 40% o supera 160%. |
| RF-6 · Retención | Retención de 1 a 5 minutos, priorización por severidad y reasignación al siguiente paradero cuando dos recomendaciones compiten por la misma capacidad. |
| RF-7 · Mapa e historia | Canvas con 310 buses, estela equivalente a 3 minutos y búfer circular local de 241 muestras por bus —una cada 30 s— para cubrir 2 horas. |
| RF-8 · Sin conexión | App shell en caché, último estado visible, cola local de acciones e intento automático de sincronización al recuperar la señal. |

## Cumplimiento técnico

| Requisito | Implementación |
|---|---|
| RT-1 | Índice, proyección, asignación y alertas se ejecutan en `simulation.worker.js`; el hilo principal dibuja y atiende la interfaz. |
| RT-2 | Dos regiones de `SharedArrayBuffer`, cada una con 310 × 8 valores. El escritor publica el búfer inactivo y cambia el índice atómicamente. |
| RT-3 | `Atomics.load/store/add/notify`; el lector comprueba la versión antes y después de tomar el índice. No se usa `Atomics.wait` en el hilo principal. |
| RT-4 | `postMessage` transmite control, alertas y métricas. El estado completo no se copia por cuadro cuando el contexto está aislado. |
| RT-5 | El Service Worker añade COOP, COEP y CORP a las respuestas del mismo origen; no existen dependencias ni mosaicos externos. |
| RT-6 | `service-worker.js` conserva interfaz, scripts y manifiesto; también mantiene la cola de acciones en IndexedDB. |
| RT-7 | Un solo Canvas dentro de `requestAnimationFrame`, descarte de objetos fuera de la vista y cero nodos DOM por bus. |
| RT-8 | `PerformanceObserver` registra INP y tareas largas; FPS e INP aparecen en la pantalla. |
| RT-9 | Dedicated Worker: cálculo por pestaña. Shared Worker: coordinación entre pestañas. Service Worker: red, caché y operación offline. |
| RT-10 | Proyecto estático desplegable mediante HTTPS y adaptable a escritorio y móvil. |

## Diseño de los algoritmos

### Índice espacial

Se eligió una rejilla uniforme porque la red se consulta muchas más veces de las que se modifica. Su construcción es `O(S)`, donde `S` es el número de segmentos. Una consulta cuesta `O(k)` sobre los candidatos de las celdas vecinas. El centro puede concentrar más segmentos, pero la consulta sigue evitando recorrer los aproximadamente 40.000 vértices.

### Asignación con memoria de secuencia

Cada observación genera hasta `C = 10` candidatos. La ventana mantiene `W = 5` observaciones. La programación dinámica cuesta `O(W · C²)`, con un máximo acotado de aproximadamente 500 comparaciones por mensaje. El término de emisión penaliza la distancia al segmento; la transición penaliza retrocesos y saltos incompatibles con la distancia recorrida.

### Posición sobre la polilínea

La proyección usa producto punto sobre cada segmento candidato. La posición resulta de sumar el índice del segmento y la fracción recorrida. Las coordenadas sintéticas están normalizadas en un plano local; con coordenadas reales se debe proyectar la zona de operación a un sistema métrico local antes de calcular distancias.

### Percentiles en flujo

Cada ruta se divide en 12 tramos y cada tramo conserva 48 cubetas de 15 segundos. Memoria: `22 × 12 × 48 × 4 = 50.688 bytes`. El error máximo por redondeo es aproximadamente la mitad del ancho de cubeta: 7,5 segundos.

### Orden dinámico y conflictos

Con solo 310 buses, ordenar por ruta una vez por segundo tiene un costo pequeño y verificable. La recomendación de retención usa una heurística voraz: atiende primero el riesgo de mayor severidad y mueve la segunda recomendación al próximo paradero cuando la capacidad está ocupada. No garantiza el óptimo global, pero produce una decisión inmediata y nunca deja una recomendación sin paradero.

### Historial local

El historial guarda 241 posiciones de progreso por bus, equivalentes a dos horas más la muestra actual con frecuencia de 30 segundos. Ocupa `310 × 241 × 4 = 298.840 bytes`. Al llenarse, el cursor circular reemplaza la muestra más antigua.

## Estructura

```text
dist/
  index.html              Interfaz accesible y paneles de operación
  styles.css              Diseño adaptable para escritorio y móvil
  app.js                  Canvas, interacción, memoria compartida e INP
  simulation.worker.js    Cartografía, GPS, map matching y alertas
  shared.worker.js        Coordinación entre pestañas
  service-worker.js       Aislamiento, caché y cola offline
  manifest.webmanifest    Instalación como aplicación web
data/
  trayecto_calles_paralelas.csv
tests/
  map-matching.test.mjs
INFORME_TECNICO.md
```

## Formato compatible para reemplazar la cartografía

El generador sintético produce 22 polilíneas. Para integrar el archivo original se debe convertir cada ruta a un arreglo ordenado de pares `[x, y]` o `[longitud, latitud]`, conservando:

- identificador de ruta;
- orden de los vértices;
- paraderos con posición acumulada sobre la polilínea;
- capacidad física de cada paradero.

El índice espacial, la asignación secuencial, el cálculo de intervalos y la interfaz no necesitan cambios.
