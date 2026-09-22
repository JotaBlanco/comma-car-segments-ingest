/** The partition column a row stands for, shown on hover or while the row is open. */
export default function KeyTag({ name }: { name: string }) {
  return (
    <span className="tree-key" title="Partition key">
      {name}
    </span>
  );
}
