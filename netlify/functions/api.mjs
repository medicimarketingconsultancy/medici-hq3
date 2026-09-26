import { getStore } from "@netlify/blobs";
import { handle } from "../../lib/app.mjs";

export default async (req) =>
  handle(req, {
    store: getStore({ name: "medici-hq", consistency: "strong" }),
    env: {
      ADMIN_PASSWORD: Netlify.env.get("ADMIN_PASSWORD"),
      SESSION_SECRET: Netlify.env.get("SESSION_SECRET"),
      SCANNER_TOKEN: Netlify.env.get("SCANNER_TOKEN"),
      INBOUND_TOKEN: Netlify.env.get("INBOUND_TOKEN"),
      SITE_ORIGINS: Netlify.env.get("SITE_ORIGINS"),
    },
  });

export const config = { path: "/api/*" };
