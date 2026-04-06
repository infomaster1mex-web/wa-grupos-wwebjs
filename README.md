# WhatsApp Groups Publisher (whatsapp-web.js)

Bot minimo para probar envio a grupos con `whatsapp-web.js` en Railway.

## Variables

- `SOS_API_KEY`
- `SESSION_ID=grupos`
- `GROUP_SEND_TIMEOUT_MS=90000`
- `AUTH_ROOT=/app/auth_info`
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`

## Railway

Monta un volumen persistente en:

`/app/auth_info`

## Rutas

- `GET /`
- `GET /status`
- `GET /qr`
- `GET /grupos/lista?api_key=TU_API_KEY`
- `POST /grupos/enviar`
- `POST /test/grupos`
- `GET /crypto/limpiar?api_key=TU_API_KEY`
- `GET /reauth?api_key=TU_API_KEY`

## Ejemplo envio texto

```js
fetch('https://TU-URL.up.railway.app/grupos/enviar', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    api_key: 'TU_API_KEY',
    grupo_ids: ['1203...@g.us'],
    mensaje: 'Prueba desde whatsapp-web.js'
  })
}).then(r => r.json()).then(console.log)
```
