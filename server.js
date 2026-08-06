// ------------------------------------------------------------------
// MINI-COCINA v3: la despensa ahora vive AFUERA del servidor.
//
// Antes usábamos un archivo (datos.db) guardado en el propio disco
// del servidor. El problema: en el plan gratis de Render, ese disco
// se borra cada vez que el servidor se "duerme" por inactividad y
// se vuelve a prender. Por eso los datos desaparecían solos.
//
// Ahora usamos una base de datos PostgreSQL alojada en Neon
// (neon.tech), que es un servicio aparte, siempre encendido,
// pensado específicamente para guardar datos de forma permanente.
// El servidor y la base de datos ya no comparten "cajón" -- así,
// aunque el servidor se duerma y se despierte, la base de datos
// ni se entera.
// ------------------------------------------------------------------

const express = require('express');
const { Pool } = require('pg');
const path = require('node:path');
const app = express();
app.use(express.json());

// Sirve la webapp de la cocina (la carpeta "public") en la dirección principal.
app.use(express.static(path.join(__dirname, 'public')));

// Permite que la webapp le hable a este servidor sin que el navegador lo bloquee.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Conexión a la base de datos externa. La dirección de conexión
// (DATABASE_URL) NO va escrita acá en el código -- se configura
// como variable de entorno en Render, por seguridad (es como la
// llave de la despensa: no se deja tirada a la vista de cualquiera).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Si la tabla todavía no existe en la base de datos, la creamos.
async function prepararBaseDeDatos(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datos_cocina (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      contenido TEXT NOT NULL
    )
  `);
  console.log('Base de datos lista.');
}
prepararBaseDeDatos().catch(err => {
  console.error('No se pudo preparar la base de datos:', err.message);
});

// PEDIDO: "Dame todos los datos de la webapp de cocina"
app.get('/datos', async (req, res) => {
  try{
    const resultado = await pool.query('SELECT contenido FROM datos_cocina WHERE id = 1');
    if(resultado.rows.length === 0){
      return res.json({ recipes: [], menusByDate: {} });
    }
    console.log('Alguien pidió los datos de la cocina');
    res.json(JSON.parse(resultado.rows[0].contenido));
  }catch(err){
    console.error('Error leyendo la base de datos:', err.message);
    res.status(500).json({ error: 'No se pudo leer la base de datos' });
  }
});

// PEDIDO: "Guardá estos datos de la webapp de cocina" (reemplaza todo)
app.put('/datos', async (req, res) => {
  try{
    const contenido = JSON.stringify(req.body || {});
    await pool.query(`
      INSERT INTO datos_cocina (id, contenido) VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET contenido = EXCLUDED.contenido
    `, [contenido]);
    console.log('Se guardaron los datos de la cocina en la base de datos');
    res.json({ mensaje: 'Guardado correctamente' });
  }catch(err){
    console.error('Error guardando en la base de datos:', err.message);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La cocina está prendida y escuchando en el puerto ${PORT}`);
});
