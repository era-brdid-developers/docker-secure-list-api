import jwt from "jsonwebtoken";

export function makeAuthMiddleware(env) {
  const alg = env.JWT_ALG || "RS256";
  const verifyOpts = { algorithms: [alg] };
  let key;

  if (alg === "RS256") {
    const pubB64 = env.JWT_PUBLIC_KEY_BASE64;
    if (!pubB64) throw new Error("JWT_PUBLIC_KEY_BASE64 ausente");
    key = Buffer.from(pubB64, "base64").toString("utf8");
  } else if (alg === "HS256") {
    key = env.JWT_SECRET;
    if (!key) throw new Error("JWT_SECRET ausente");
  } else {
    throw new Error("Algoritmo JWT não suportado");
  }

  return function auth(req, res, next) {
    try {
      const raw = req.headers.authorization || "";
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
      if (!token) return res.status(401).json({ error: "missing_token" });

      const payload = jwt.verify(token, key, verifyOpts);
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      
      if (!scopes.includes("docker:list")) {
        return res.status(403).json({ error: "forbidden" });
      }

      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}
