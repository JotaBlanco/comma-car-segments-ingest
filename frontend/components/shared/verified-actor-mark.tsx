import { Check } from "lucide-react";

const VERIFIED_LABEL = "Verified by the Quix platform";

interface VerifiedActorMarkProps {
  actorId: string | null;
}

/**
 * Marks an actor that the Quix platform verified.
 * Renders nothing without an id, because absence of the mark is the signal.
 * The OpenAPI snapshot makes `actor_id` optional, so an older API can omit the key.
 */
export function VerifiedActorMark({ actorId }: VerifiedActorMarkProps) {
  if (!actorId) return null;
  return (
    <span
      role="img"
      aria-label={VERIFIED_LABEL}
      title={VERIFIED_LABEL}
      className="ml-0.5 inline-flex align-[-1px]"
    >
      <Check className="size-2.5" strokeWidth={2.6} aria-hidden />
    </span>
  );
}
