# wa-grupos-wwebjs-ia

Bot para Railway con:
- `whatsapp-web.js`
- envío a grupos
- control por WhatsApp desde un número admin
- soporte IA opcional para entender instrucciones en lenguaje natural

## Variables
- `SOS_API_KEY`
- `SESSION_ID`
- `ADMIN_PHONE`
- `AUTH_ROOT=/app/auth_info`
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- `GROUP_SEND_TIMEOUT_MS=90000`
- `SEND_PAUSE_MS=1500`
- `GROUP_SKIP_COMMUNITIES=true`
- `OPENAI_API_KEY` (opcional)
- `OPENAI_MODEL` (opcional)

## Volumen Railway
Montar en:

`/app/auth_info`

## Uso por WhatsApp (desde el número admin)
- Texto directo:
  - `manda esto a grupos: tu promo aqui`
- Imagen/video:
  - manda la imagen o video
  - luego manda el caption si quieres
  - luego escribe `grupos`

## Comandos admin
- `!status`
- `!grupos`
- `!test`
- `!clear`
- `!reauth`

## Endpoints
- `GET /`
- `GET /status`
- `GET /qr`
- `GET /grupos/lista?api_key=...`
- `POST /grupos/enviar`
- `GET /test/grupos?api_key=...`
- `GET /reauth?api_key=...`
