# WhatsApp automation

HomeTech sends WhatsApp messages server-side through the open-source [Evolution API](https://github.com/evolution-foundation/evolution-api), pinned to v2.3.7 in `docker-compose.whatsapp.yml`.

## Required configuration

Set these secrets in the deployment environment (never in client-side `NEXT_PUBLIC_*` variables):

```text
WHATSAPP_API_URL=http://127.0.0.1:8080
WHATSAPP_API_KEY=<a-long-random-secret>
WHATSAPP_INSTANCE_NAME=hometech
WHATSAPP_DB_PASSWORD=<a-different-long-random-secret>
```

When the Next.js app and Evolution API run inside the same Docker network, use `WHATSAPP_API_URL=http://evolution-api:8080` for the web service.

For a local Next.js process, start the messaging service with:

```text
docker compose -f docker-compose.whatsapp.yml up -d
```

For the fully containerized application, combine both Compose files so the web service can reach `evolution-api` on the shared project network:

```text
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up -d
```

Then sign in as an administrator, open **Administration → WhatsApp Automation**, and scan the QR code once from WhatsApp **Linked devices**. After the status becomes **Connected**, payment, order, invoice, and support messages are sent automatically without opening WhatsApp.

## Production note

The free Baileys connection emulates WhatsApp Web and is not an official Meta channel. Use a dedicated business number, keep message volume conservative, and avoid unsolicited bulk messaging. The application isolates sending behind `src/lib/whatsapp-automation.ts`, so an official Meta Cloud API transport can replace Evolution without changing the payment/order/invoice screens.
