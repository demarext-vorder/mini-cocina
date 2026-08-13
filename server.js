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
app.use(express.json({ limit: '5mb' })); // 5mb alcanza de sobra para una foto ya comprimida

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
  // Tabla aparte solo para las fotos de las recetas. Al vivir separada,
  // subir o cambiar una foto no tiene nada que ver con guardar recetas,
  // menúes, listas, etc. -- son guardados totalmente independientes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS imagenes_recetas (
      receta_id TEXT PRIMARY KEY,
      imagen TEXT NOT NULL
    )
  `);
  console.log('Base de datos lista.');
}
prepararBaseDeDatos().catch(err => {
  console.error('No se pudo preparar la base de datos:', err.message);
});

// PEDIDO: "Dame todos los datos de la webapp de cocina" (libre, sin contraseña)
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

// Filtro de contraseña: solo se usa para GUARDAR (PUT), no para leer.
// La contraseña real vive en Render como variable de entorno (APP_PASSWORD),
// nunca acá en el código -- así no queda expuesta en GitHub, que es público.
function verificarContrasena(req, res, next){
  const recibida = req.header('X-App-Password');
  const correcta = process.env.APP_PASSWORD;
  if(!correcta){
    // Si todavía no configuraste APP_PASSWORD en Render, no bloqueamos
    // nada (para no dejarte trabado), pero avisamos en los logs.
    console.warn('APP_PASSWORD no está configurada -- el guardado queda sin protección.');
    return next();
  }
  if(recibida !== correcta){
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  next();
}

// PEDIDO: "Guardá estos datos de la webapp de cocina" (reemplaza todo, PIDE CONTRASEÑA)
app.put('/datos', verificarContrasena, async (req, res) => {
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

// ------------------------------------------------------------------
// Imágenes de recetas (tabla separada -- ver comentario más arriba)
// ------------------------------------------------------------------

// PEDIDO: "Decime qué recetas tienen foto" (liviano: solo ids, sin la imagen en sí)
app.get('/imagenes', async (req, res) => {
  try{
    const resultado = await pool.query('SELECT receta_id FROM imagenes_recetas');
    res.json(resultado.rows.map(r => r.receta_id));
  }catch(err){
    console.error('Error listando imágenes:', err.message);
    res.status(500).json({ error: 'No se pudo leer la lista de imágenes' });
  }
});

// PEDIDO: "Dame la foto de esta receta puntual" (libre, sin contraseña)
app.get('/imagenes/:recetaId', async (req, res) => {
  try{
    const resultado = await pool.query(
      'SELECT imagen FROM imagenes_recetas WHERE receta_id = $1',
      [req.params.recetaId]
    );
    if(resultado.rows.length === 0){
      return res.status(404).json({ error: 'Esta receta no tiene foto guardada' });
    }
    res.json({ recetaId: req.params.recetaId, imagen: resultado.rows[0].imagen });
  }catch(err){
    console.error('Error leyendo imagen:', err.message);
    res.status(500).json({ error: 'No se pudo leer la imagen' });
  }
});

// PEDIDO: "Guardá/reemplazá la foto de esta receta" (PIDE CONTRASEÑA)
app.put('/imagenes/:recetaId', verificarContrasena, async (req, res) => {
  try{
    const imagen = req.body && req.body.imagen;
    if(!imagen){
      return res.status(400).json({ error: 'Falta la imagen' });
    }
    await pool.query(`
      INSERT INTO imagenes_recetas (receta_id, imagen) VALUES ($1, $2)
      ON CONFLICT (receta_id) DO UPDATE SET imagen = EXCLUDED.imagen
    `, [req.params.recetaId, imagen]);
    console.log('Se guardó la foto de la receta', req.params.recetaId);
    res.json({ mensaje: 'Imagen guardada correctamente' });
  }catch(err){
    console.error('Error guardando imagen:', err.message);
    res.status(500).json({ error: 'No se pudo guardar la imagen' });
  }
});

// PEDIDO: "Borrá la foto de esta receta" (PIDE CONTRASEÑA)
// Se usa tanto si el usuario saca la foto de una receta, como
// automáticamente cuando se borra la receta entera.
app.delete('/imagenes/:recetaId', verificarContrasena, async (req, res) => {
  try{
    await pool.query('DELETE FROM imagenes_recetas WHERE receta_id = $1', [req.params.recetaId]);
    console.log('Se borró la foto de la receta', req.params.recetaId);
    res.json({ mensaje: 'Imagen borrada correctamente' });
  }catch(err){
    console.error('Error borrando imagen:', err.message);
    res.status(500).json({ error: 'No se pudo borrar la imagen' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`La cocina está prendida y escuchando en el puerto ${PORT}`);
});
