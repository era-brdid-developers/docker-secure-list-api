import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

export function makeSecurity(app, { corsOrigins }) {
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  const origins = (corsOrigins || "").split(",").map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: origins.length ? origins : false,
    methods: ["GET"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600
  }));

  app.use(hpp());
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  }));
}
