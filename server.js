// ------------------------------------------------------------------
// MINI-COCINA v2: ahora con DESPENSA REAL (base de datos SQLite).
//
// La diferencia con la v1: antes las recetas vivían en un array de
// JavaScript (memoria = se borra al reiniciar). Ahora viven en un
// ARCHIVO llamado "datos.db" en este mismo directorio. Podés apagar
// el servidor, prender la compu de nuevo dentro de un mes, y esas
// recetas van a seguir estando ahí adentro del archivo.
// ------------------------------------------------------------------

const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // el "motor" de la despensa
const path = require('node:path');
const app = express();
app.use(express.json());

// Esto hace que el servidor le muestre la webapp de la cocina a
// cualquiera que entre a la dirección principal (https://.../),
// en vez de solo responder pedidos de datos.
app.use(express.static(path.join(__dirname, 'public')));

// Permite que nuestra webapp (que vive en otra dirección) le pueda
// hablar a este servidor. Sin esto, el navegador bloquea el pedido
// por seguridad (política de "mismo origen").
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Abrimos (o creamos si no existe) el archivo que es nuestra despensa.
const db = new DatabaseSync('datos.db');

// Si la "estantería" (tabla) todavía no existe dentro del archivo, la creamos.
db.exec(`
  CREATE TABLE IF NOT EXISTS recetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL
  )
`);

// Tabla nueva: acá va a vivir TODO lo de la webapp de la cocina
// (recetas con ingredientes, y las planillas por fecha), como un
// único paquete de datos. Es más simple que armar una tabla por
// cada cosa, y alcanza perfecto para este uso.
db.exec(`
  CREATE TABLE IF NOT EXISTS datos_cocina (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    contenido TEXT NOT NULL
  )
`);

// PEDIDO: "Dame todos los datos de la webapp de cocina"
app.get('/datos', (req, res) => {
  const fila = db.prepare('SELECT contenido FROM datos_cocina WHERE id = 1').get();
  if (!fila) {
    return res.json({ recipes: [], menusByDate: {} });
  }
  console.log('Alguien pidió los datos de la cocina');
  res.json(JSON.parse(fila.contenido));
});

// PEDIDO: "Guardá estos datos de la webapp de cocina" (reemplaza todo)
app.put('/datos', (req, res) => {
  const contenido = JSON.stringify(req.body || {});
  db.prepare(`
    INSERT INTO datos_cocina (id, contenido) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET contenido = excluded.contenido
  `).run(contenido);
  console.log('Se guardaron los datos de la cocina en la despensa');
  res.json({ mensaje: 'Guardado correctamente' });
});

// ------------------------------------------------------------------
// Lo de acá abajo es de la lección anterior (recetas sueltas de prueba).
// Lo dejamos, no molesta, pero ya no lo usa la webapp real.
// ------------------------------------------------------------------

// PEDIDO 1: "Dame todas las recetas" -> ahora lee del archivo, no de memoria
app.get('/recetas', (req, res) => {
  const filas = db.prepare('SELECT * FROM recetas ORDER BY id').all();
  console.log(`Alguien pidió la lista de recetas (hay ${filas.length} guardadas en el archivo)`);
  res.json(filas);
});

// PEDIDO 2: "Agregá esta receta nueva" -> ahora escribe en el archivo
app.post('/recetas', (req, res) => {
  const nombre = req.body.nombre;
  if (!nombre) {
    return res.status(400).json({ error: 'Falta el nombre de la receta' });
  }
  const resultado = db.prepare('INSERT INTO recetas (nombre) VALUES (?)').run(nombre);
  const nueva = { id: resultado.lastInsertRowid, nombre };
  console.log('Se guardó en el archivo una receta nueva:', nombre);
  res.status(201).json(nueva);
});

// ------------------------------------------------------------------
// RUTA TEMPORAL SOLO PARA PROBAR DESDE EL NAVEGADOR (sin Postman/curl).
// Uso: /recetas/agregar?nombre=Milanesa
// Esto NO se hace así en una app real (se usa POST), pero nos sirve
// ahora para verificar que la despensa guarda datos de verdad.
// ------------------------------------------------------------------
app.get('/recetas/agregar', (req, res) => {
  const nombre = req.query.nombre;
  if (!nombre) {
    return res.status(400).send('Agregá ?nombre=ALGO al final de la dirección');
  }
  const resultado = db.prepare('INSERT INTO recetas (nombre) VALUES (?)').run(nombre);
  res.json({ id: resultado.lastInsertRowid, nombre, mensaje: 'Guardado correctamente' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La cocina está prendida y escuchando en el puerto ${PORT}`);
  console.log('La despensa es el archivo: datos.db');
});
