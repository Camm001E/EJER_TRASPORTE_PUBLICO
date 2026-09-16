# Informe técnico — Control de frecuencia del transporte público

## 1. Propósito

El sistema transforma mediciones GPS imperfectas en una posición operacional confiable para 310 buses distribuidos en 22 rutas. A partir de esa posición calcula intervalos entre unidades, anticipa agrupamientos y presenta una recomendación antes de que el deterioro del servicio sea irreversible.

La solución incluye una simulación reproducible, pues no fue suministrado el archivo cartográfico de 6 MB citado en el caso. Se generaron 40.040 vértices, calles paralelas, tramos compartidos y 22 recorridos determinísticos.

## 2. Arquitectura

La interfaz mantiene una separación estricta entre presentación y cálculo:

- **Hilo principal:** eventos del usuario, lectura no bloqueante del estado y dibujo en Canvas.
- **Dedicated Web Worker:** simulación GPS, índice espacial, asignación secuencial, percentiles, intervalos y alertas.
- **Shared Worker:** coordinación de resúmenes entre varias pestañas.
- **Service Worker:** caché, respuestas con aislamiento de origen y cola de acciones del supervisor.

El estado vivo utiliza doble búfer. El Worker escribe en la región inactiva, publica el índice mediante `Atomics.store` e incrementa la versión. El lector comprueba la versión antes y después de leer el índice. Si cambia, reintenta sin bloquear.

## 3. Tratamiento de los datos imperfectos

El simulador reproduce:

- error ordinario equivalente a 8–15 metros;
- rebotes ocasionales equivalentes a 60 metros;
- silencios entre 40 segundos y 4 minutos;
- desfases de reloj de hasta 90 segundos;
- 3% de mensajes fuera de orden;
- aproximadamente 12% de buses en vacío o fuera de servicio.

Los mensajes antiguos se descartan. Durante un silencio, la posición se proyecta con la velocidad anterior y se identifica visualmente como estimada. Los buses fuera de servicio no participan en intervalos ni alertas.

## 4. Selección de algoritmos

| Problema | Elección | Costo / límite |
|---|---|---|
| Búsqueda espacial | Rejilla uniforme de 0,025 unidades | Construcción `O(S)`; consulta `O(k)` |
| Asignación vial | Programación dinámica en ventana móvil | `O(W·C²)`, con `W=5`, `C≤10` |
| Proyección | Distancia punto-segmento | `O(C)` por mensaje |
| Percentiles | Histograma de 48 cubetas | 50.688 bytes; error aprox. ±7,5 s |
| Orden de buses | Ordenamiento por ruta al evaluar alertas | `O(n log n)`, `n≤15` por ruta |
| Conflictos | Heurística voraz por severidad | Decisión inmediata; no óptimo global |
| Historial | Búfer circular por bus | 298.840 bytes para 2 horas |

## 5. Criterio de asignación secuencial

El costo total combina:

1. **Emisión:** distancia cuadrática entre la observación GPS y el segmento.
2. **Coherencia del avance:** diferencia entre desplazamiento observado y esperado.
3. **Retroceso:** penalización alta cuando el candidato obliga a retroceder sin evidencia.

El trayecto etiquetado permanece en la calle A mientras el GPS rebota nueve veces hacia una calle paralela. El vecino más cercano cambia de calle 18 veces. La memoria de secuencia produce 0 cambios falsos, por debajo del máximo aceptado de 3.

## 6. Detección y recomendación

Para una frecuencia programada `H`:

- agrupamiento si `intervalo < 0,40H`;
- hueco de servicio si `intervalo > 1,60H`.

La alerta contiene ruta, bus, intervalo proyectado, confianza y acción sugerida. La retención se limita a 1–5 minutos. Antes de publicarla se comprueba que no genere un hueco mayor y que el paradero no esté reservado por una recomendación más severa. En caso de conflicto, la segunda se desplaza al próximo paradero disponible.

## 7. Rendimiento e instrumentación

| Elemento | Tamaño o frecuencia | Transferencia al hilo principal |
|---|---:|---:|
| Estado de flota | 310 × 8 × 4 = 9.920 bytes | 0 bytes por cuadro en modo compartido |
| Mensajes GPS simulados | 31 por segundo | 0; se procesan en Worker |
| Alertas y métricas | 1 actualización por segundo | JSON pequeño, típicamente menor de 5 KB |
| Renderizado | `requestAnimationFrame` | Un Canvas, sin nodos por bus |
| Historial de 2 horas | 298.840 bytes | Consulta local, sin red |

`PerformanceObserver` registra INP y tareas largas. La propia aplicación muestra FPS, INP y número de tareas largas para que la medición se haga en el dispositivo de la sustentación. El objetivo operacional es 60 fps e INP no mayor de 200 ms.

## 8. Operación offline

El Service Worker conserva la interfaz, estilos, Workers y manifiesto. El supervisor puede abrir la aplicación sin red, consultar el último estado y registrar una retención, un bus en vacío o un incidente. Las acciones se guardan localmente y se eliminan de la cola al recuperar la conexión.

## 9. Limitación conocida y sustitución de datos

La geometría incluida es sintética porque no se recibió el archivo estático anunciado en el enunciado. Esta limitación afecta únicamente la forma concreta de las calles. Los volúmenes, fenómenos, algoritmos, interfaz, simulación y criterios de aceptación permanecen demostrables. Al recibir el archivo, basta convertir sus polilíneas al formato interno ordenado y regenerar el índice.

## 10. Conclusión

La aplicación demuestra que la regularidad no puede controlarse mostrando puntos GPS sin procesar. El valor operativo aparece al combinar indexación espacial, memoria de secuencia, orden dinámico, predicción y una recomendación ejecutable. La arquitectura mantiene esa carga fuera del hilo principal y conserva la capacidad de operación cuando la conectividad es irregular.
