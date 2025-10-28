// api/proxy.js
import { StringStream } from "scramjet";
import cheerio from "cheerio";

/**
 * GET /api/proxy?url=<encoded-url>
 * Example: /api/proxy?url=https%3A%2F%2Fexample.com
 */
export default async function handler(req, res) {
  const raw = req.query.url;
  if (!raw) return res.status(400).send("missing url");

  let target;
  try {
    target = new URL(raw);
    if (!["http:", "https:"].includes(target.protocol)) throw 0;
  } catch (e) {
    return res.status(400).send("invalid url");
  }

  // fetch upstream (Vercel functions have global fetch)
  let upstream;
  try {
    upstream = await fetch(target.toString(), { redirect: "follow" });
  } catch (e) {
    return res.status(502).send("upstream fetch failed");
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

  // Stream non-html straight back (small responses may still be buffered by platform)
  if (!contentType.includes("text/html")) {
    res.setHeader("content-type", contentType || "application/octet-stream");
    // copy cache header if any
    const cache = upstream.headers.get("cache-control");
    if (cache) res.setHeader("cache-control", cache);
    const body = upstream.body;
    if (!body) return res.status(500).send("no body");
    // Node/Platform readable stream -> express-like res
    return body.pipe ? body.pipe(res) : (await upstream.arrayBuffer(), res.end(Buffer.from(await upstream.arrayBuffer())));
  }

  // HTML: stream -> scramjet StringStream -> transform with cheerio -> send
  try {
    const txt = await upstream.text(); // small/medium pages only (Vercel has payload limits)
    await StringStream.from(txt)
      .use(async (html) => {
        const $ = cheerio.load(html);

        function proxify(orig) {
          if (!orig) return orig;
          if (orig.startsWith("javascript:") || orig.startsWith("#")) return orig;
          try {
            const abs = new URL(orig, target).toString();
            return `/api/proxy?url=${encodeURIComponent(abs)}`;
          } catch (e) {
            return orig;
          }
        }

        // rewrite common attrs
        $("[href]").each((i, el) => {
          const v = $(el).attr("href");
          $(el).attr("href", proxify(v));
        });
        $("[src]").each((i, el) => {
          const v = $(el).attr("src");
          $(el).attr("src", proxify(v));
        });
        $("link[rel='stylesheet'][href]").each((i, el) => {
          const v = $(el).attr("href");
          $(el).attr("href", proxify(v));
        });
        $("base").remove(); // avoid base messing up relative links

        return $.html();
      })
      .reduce((acc, c) => acc + c, "")
      .then(finalHtml => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.send(finalHtml);
      });
  } catch (err) {
    console.error(err);
    return res.status(500).send("transform error");
  }
}
