# Call Up — fiber check landing

Static landing page that checks fiber availability against the kma-crm API, then collects a name and phone number.

## Run

```bash
cp public/config.example.js public/config.js   # set apiUrl + the Callup company's API token
```

Serve `public/` with any static server (VS Code Live Server, `python3 -m http.server -d public 8130`, …).

The browser calls kma-crm directly:

| Call | Used for |
| --- | --- |
| `GET /cities` | city autocomplete |
| `GET /streets` | street autocomplete (full list, fetched once, grouped by city) |
| `POST /check` | run for `bezeq` and `ibc` in parallel; fiber = Bezeq `gpon` or IBC technology GPON/XGSPON/AE |
| `POST /coordinates-to-address` | "my location" button: address shown to the user (the one from the provider the result came from) |

"My location" converts the browser position to ITM (proj4, EPSG:2039) and sends `coordinates` to `POST /check`. Browsers only allow it over HTTPS or localhost. Positions less accurate than 500 m are rejected.

**Note:** the API token in `config.js` is visible to anyone who opens the page. It can call every kma-crm API endpoint, including orders.

The lead form (name + phone) is validated and POSTed as `phone_number`, `fullname` and `source` to `leadUrl` (default `https://www.callup.co/main/saveLandingLeadFiber`); `source` comes from `leadSource` in `config.js`.
