import './ai.css';

/** The XS AI mark: a living gradient orb. */
export function AiOrb({ size = 72, state = 'idle' }: { size?: number; state?: 'idle' | 'listening' | 'thinking' }) {
  return (
    <span className={`xsai-orb is-${state}`} style={{ width: size, height: size }} aria-hidden>
      <span className="xsai-orb-core" /><span className="xsai-orb-shine" />
    </span>
  );
}
