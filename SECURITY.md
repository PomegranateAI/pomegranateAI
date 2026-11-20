# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub: on this repository, open **Security → Report a
vulnerability**. Include what you found, how to reproduce it, and the impact
you expect.

We will acknowledge a report within 3 business days and keep you updated
until it is resolved. Please give us a reasonable time to ship a fix before
disclosing details publicly.

## Scope

Reports about this code are in scope: the server (`app/server`), the web app
(`app/web`) and the bots (`surfaces/`). Issues in a third-party dependency
should also be reported to that project.

## Running your own server safely

- Keep `SIGNUP_MODE` unset (closed) unless anyone on the internet may create
  an account.
- Configure mail (`RESEND_API_KEY` + `MAIL_FROM`, or `SMTP_URL`) and never set
  `POMEGRANATE_DEV_INLINE_CODES` or `POMEGRANATE_SINGLE_USER` on a server
  other people can reach.
- Keep `POMEGRANATE_LLM_LOG_VERBATIM` unset, so model logs never hold user
  text.
- Serve everything over HTTPS and set `PUBLIC_ORIGIN` to the public URL.
- Behind a reverse proxy, set `POMEGRANATE_TRUSTED_PROXY_HOPS` to the number of
  proxies, and send a Content-Security-Policy header (see the README's proxy
  example).
- Set `SURFACE_AGENT_SECRET` only if you run the bots or an external scheduler;
  `/internal/updates/run-due` is disabled without it.
- For encryption at rest, set `POMEGRANATE_SEAL=1` with a key provider (see
  `app/server/.env.example`).
