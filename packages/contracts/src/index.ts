export interface HealthResponse {
  status: "ok";
}

export interface ReadinessResponse {
  status: "ok" | "degraded";
  checks: {
    database: "ok" | "unavailable";
    redis: "ok" | "unavailable";
  };
}
