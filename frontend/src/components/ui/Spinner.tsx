import { MarkLoader } from '@/components/brand/Mark';

/** Busy indicator. Drawn as the mark, with the sun rising between the stones. */
export function Spinner({ className }: { className?: string }) {
  return <MarkLoader className={className} />;
}
