import type { HomeSummary } from "@/types";
import { api } from "./client";

export const homeApi = {
  summary: () => api.get<HomeSummary>("/home/summary"),
};
