import { useSession } from '../../store/session';
import Adi from '../adi/Adi';
import HeadingTape from './HeadingTape';
import Tape from './Tape';

export default function Instruments() {
  const flight = useSession((s) => s.flight);
  if (!flight) {
    return <div className="h-full grid place-items-center text-muted">No flight data</div>;
  }
  return (
    <div className="h-full flex flex-col gap-1 px-2 py-1">
      <div className="flex-1 min-h-0 flex items-stretch justify-center gap-2">
        <Tape col="cas" label="CAS" min={0} max={200} step={10} span={60} />
        <Tape col="gs" label="GS" min={0} max={200} step={10} span={60} />
        <div className="h-full aspect-square">
          <Adi />
        </div>
        <Tape col="alt" label="ALT" min={0} max={5000} step={100} span={600} />
        <Tape col="vs" label="VS" min={-2000} max={2000} step={200} span={1200} />
      </div>
      <HeadingTape />
    </div>
  );
}
