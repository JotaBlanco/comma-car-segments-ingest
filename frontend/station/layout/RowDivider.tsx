import type { CSSProperties } from 'react';

interface Props {
  style?: CSSProperties;
  axis: 'x' | 'y';
  label: string;
  onDrag(delta: number): void;
  onReset(): void;
  onStart(): void;
}

/** A draggable line between two panels, or under a row. */
export default function RowDivider({ axis, label, onDrag, onReset, onStart, style }: Props) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const origin = axis === 'x' ? e.clientX : e.clientY;
    handle.setPointerCapture(e.pointerId);
    onStart();
    const move = (ev: PointerEvent) => onDrag((axis === 'x' ? ev.clientX : ev.clientY) - origin);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  };
  return (
    <div
      className={`row-divider row-divider-${axis}`}
      style={style}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title="Drag to resize, double-click to reset"
      onPointerDown={start}
      onDoubleClick={onReset}
    />
  );
}
