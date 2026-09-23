import { useQuery } from "@tanstack/react-query";
import { listAllNotebooks } from "@/lib/api/run-quixlab";
import { keys } from "./keys";

/** Every QuixLab notebook of every run, with this viewer's lab on each: the Workflows page. */
export function useAllNotebooks() {
  return useQuery({
    queryKey: keys.notebooks.all,
    queryFn: listAllNotebooks,
    staleTime: 15_000,
  });
}
