import { Badge } from '@/components/ui/badge';

// The red/yellow/green review-flag chip, shared by every surface that shows
// flags (Overview queue, Curate inbox, review findings).

export const FLAG_CLASS: Record<string, string> = {
  red: 'flag-red',
  yellow: 'flag-yellow',
  green: 'flag-green',
};

export function FlagChip({
  flag,
  count,
  label,
}: {
  flag: 'red' | 'yellow' | 'green';
  count?: number;
  label?: string;
}) {
  return (
    <Badge variant="outline" className={FLAG_CLASS[flag]}>
      {count != null ? `${count} ${flag}` : (label ?? flag.toUpperCase())}
    </Badge>
  );
}
