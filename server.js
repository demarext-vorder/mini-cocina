// ------------------------------------------------------------------
// MINI-COCINA v3.1: la despensa vive AFUERA del servidor.
//
// Usamos una base de datos PostgreSQL alojada en Neon (neon.tech),
// que es un servicio aparte, siempre encendido, pensado
// específicamente para guardar datos de forma permanente. El
// servidor y la base de datos no comparten "cajón" -- así, aunque
// el servidor se duerma y se despierte, la base ni se entera.
//
// NOVEDADES DE ESTA VERSIÓN (v3.1):
//  1. Si APP_PASSWORD no está configurada, el guardado se BLOQUEA
//     (antes quedaba abierto para cualquiera).
//  2. Control de versión: si dos personas editan a la vez, el
//     segundo en guardar recibe un aviso en vez de pisar en
//     silencio el trabajo del otro.
//  3. Las respuestas viajan comprimidas (gzip) -- mucho menos
//     datos por la red, sobre todo con las fotos.
//  4. Al leer, ya no desarmamos y rearmamos el JSON al pedo:
//     se manda tal cual sale de la base.
// ------------------------------------------------------------------

const express = require('express');
const { Pool } = require('pg');
const path = require('node:path');
const zlib = require('node:zlib');
const app = express();
app.use(express.json({ limit: '5mb' })); // 5mb alcanza de sobra para una foto ya comprimida

// Sirve la webapp de la cocina (la carpeta "public") en la dirección principal.
// El index.html se marca como "no-cache" para que, cuando subas una versión
// nueva, el navegador la vea enseguida en vez de quedarse con la vieja.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Permite que la webapp le hable a este servidor sin que el navegador lo bloquee.
// "Expose-Headers" es necesario para que el navegador deje leer X-Data-Version.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-Data-Version');
  res.header('Access-Control-Expose-Headers', 'X-Data-Version');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Conexión a la base de datos externa. La dirección de conexión
// (DATABASE_URL) NO va escrita acá en el código -- se configura
// como variable de entorno en Render, por seguridad (es como la
// llave de la despensa: no se deja tirada a la vista de cualquiera).
if (!process.env.DATABASE_URL) {
  console.error('FALTA DATABASE_URL: el servidor va a arrancar pero no va a poder leer ni guardar nada.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
// Si la conexión se corta sola (pasa cuando Neon duerme la base), sin este
// manejador Node tira el proceso entero abajo. Con esto, solo lo anota.
pool.on('error', (err) => {
  console.error('Conexión con la base perdida (se reconecta sola):', err.message);
});

// Si la tabla todavía no existe en la base de datos, la creamos.
async function prepararBaseDeDatos(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datos_cocina (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      contenido TEXT NOT NULL
    )
  `);
  // "version" es un contador que sube en 1 con cada guardado. Sirve para
  // detectar si otra persona guardó algo mientras vos tenías la página
  // abierta. Se agrega solo, sin tocar los datos que ya están.
  await pool.query(`
    ALTER TABLE datos_cocina ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1
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

// Manda un texto JSON al navegador, comprimido con gzip si el navegador
// lo acepta (todos lo aceptan). Un JSON de recetas de 400 KB suele quedar
// en unos 40 KB: baja mucho más rápido, sobre todo desde el celular.
function enviarJSON(req, res, texto){
  res.type('application/json');
  res.setHeader('Vary', 'Accept-Encoding');
  const aceptaGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  if(!aceptaGzip || texto.length < 1024){
    return res.send(texto);
  }
  zlib.gzip(texto, (err, comprimido) => {
    if(err) return res.send(texto);
    res.setHeader('Content-Encoding', 'gzip');
    res.send(comprimido);
  });
}

// PEDIDO: "Dame todos los datos de la webapp de cocina" (libre, sin contraseña)
app.get('/datos', async (req, res) => {
  try{
    const resultado = await pool.query('SELECT contenido, version FROM datos_cocina WHERE id = 1');
    if(resultado.rows.length === 0){
      res.setHeader('X-Data-Version', '0');
      return res.json({ recipes: [], menusByDate: {} });
    }
    console.log('Alguien pidió los datos de la cocina');
    res.setHeader('X-Data-Version', String(resultado.rows[0].version));
    // Antes hacíamos JSON.parse(...) y después res.json(...) lo volvía a
    // convertir en texto: dos vueltas al pedo sobre un texto grande.
    // Ahora se manda exactamente como está guardado.
    enviarJSON(req, res, resultado.rows[0].contenido);
  }catch(err){
    console.error('Error leyendo la base de datos:', err.message);
    res.status(500).json({ error: 'No se pudo leer la base de datos' });
  }
});

// Filtro de contraseña: solo se usa para GUARDAR (PUT/DELETE), no para leer.
// La contraseña real vive en Render como variable de entorno (APP_PASSWORD),
// nunca acá en el código -- así no queda expuesta en GitHub, que es público.
function verificarContrasena(req, res, next){
  const recibida = req.header('X-App-Password');
  const correcta = process.env.APP_PASSWORD;
  if(!correcta){
    // Antes, si faltaba APP_PASSWORD, dejábamos guardar igual: cualquiera
    // con la URL podía escribir. Ahora se bloquea (falla "cerrado", que es
    // la forma segura de fallar) y se avisa fuerte en los logs.
    console.error('APP_PASSWORD no está configurada en Render -- el guardado queda BLOQUEADO por seguridad.');
    return res.status(503).json({ error: 'El servidor no tiene contraseña configurada. Avisale al administrador.' });
  }
  if(recibida !== correcta){
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  next();
}

// PEDIDO: "Guardá estos datos de la webapp de cocina" (reemplaza todo, PIDE CONTRASEÑA)
//
// Control de versión (lo nuevo): la webapp manda en X-Data-Version el número
// de versión que leyó cuando abrió la página. Si en el medio otra persona
// guardó, el número ya no coincide y devolvemos 409 en vez de pisarle el
// trabajo. Si la webapp no manda el header (una pestaña vieja en caché),
// se guarda igual, como antes, para no dejar a nadie trabado.
app.put('/datos', verificarContrasena, async (req, res) => {
  try{
    const contenido = JSON.stringify(req.body || {});
    const esperada = parseInt(req.header('X-Data-Version'), 10);

    if(!Number.isFinite(esperada)){
      const r = await pool.query(`
        INSERT INTO datos_cocina (id, contenido, version) VALUES (1, $1, 1)
        ON CONFLICT (id) DO UPDATE SET contenido = EXCLUDED.contenido, version = datos_cocina.version + 1
        RETURNING version
      `, [contenido]);
      res.setHeader('X-Data-Version', String(r.rows[0].version));
      console.log('Se guardaron los datos de la cocina (sin control de versión)');
      return res.json({ mensaje: 'Guardado correctamente' });
    }

    // Solo actualiza si la versión sigue siendo la que el navegador tenía.
    const actualizado = await pool.query(`
      UPDATE datos_cocina SET contenido = $1, version = version + 1
      WHERE id = 1 AND version = $2
      RETURNING version
    `, [contenido, esperada]);

    if(actualizado.rowCount === 1){
      res.setHeader('X-Data-Version', String(actualizado.rows[0].version));
      console.log('Se guardaron los datos de la cocina en la base de datos');
      return res.json({ mensaje: 'Guardado correctamente' });
    }

    // No se actualizó nada: o la fila todavía no existe, o cambió la versión.
    const existe = await pool.query('SELECT version FROM datos_cocina WHERE id = 1');
    if(existe.rows.length === 0){
      await pool.query('INSERT INTO datos_cocina (id, contenido, version) VALUES (1, $1, 1)', [contenido]);
      res.setHeader('X-Data-Version', '1');
      return res.json({ mensaje: 'Guardado correctamente' });
    }

    console.warn('Guardado rechazado: otra persona guardó primero.');
    res.setHeader('X-Data-Version', String(existe.rows[0].version));
    res.status(409).json({ error: 'Otra persona guardó cambios mientras tanto' });
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
    enviarJSON(req, res, JSON.stringify({
      recetaId: req.params.recetaId,
      imagen: resultado.rows[0].imagen
    }));
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
