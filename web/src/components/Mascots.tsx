/* The dojo's critters: original characters drawn for Lingo Dojo.
 *
 * Sensei Mochi (a round rice cake with a black-belt headband) is the dojo
 * master and narrator, and the practice panel's one animated thing: its
 * mood follows the session (bowing when idle, thinking, talking, listening).
 * Tako-chan, a small octopus, stands for whoever is in the scene; Pip, a
 * bean-fox, is the kids' sidekick. In the transcript they mark who is
 * speaking, so they carry information, not decoration.
 *
 * Every colour is fixed, outline included: a mascot keeps its look in dark
 * mode (a light-mode-only ink would vanish against its own pale body). */

const INK = "#1a1c3a";
const BLUSH = "#ff9db0";

export type MochiMood = "idle" | "thinking" | "talking" | "listening" | "happy";

export function Mochi({ mood = "idle", size = 64, className = "", title }: { mood?: MochiMood; size?: number; className?: string; title?: string }) {
  const moving = mood === "thinking" || mood === "talking" || mood === "listening";
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <g className={moving ? "mochi-bob" : undefined}>
        {/* body */}
        <path d="M7 45C7 25 19 13 32 13s25 12 25 32c0 10-11 14-25 14S7 55 7 45Z" fill="#fff8ec" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
        {/* black-belt headband and its knot tails */}
        <path d="M10.5 29.5C20 25.5 44 25.5 53.5 29.5l.6 5.6C44 31.3 20 31.3 9.9 35.1Z" fill="#1a1c3a" />
        <path d="M53 31.5l7.5-3.5-2 6.5M53.5 33l6 4.5" fill="none" stroke="#1a1c3a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        {/* blush */}
        <ellipse cx="19" cy="47" rx="4" ry="2.4" fill={BLUSH} opacity="0.75" />
        <ellipse cx="45" cy="47" rx="4" ry="2.4" fill={BLUSH} opacity="0.75" />
        <MochiFace mood={mood} />
      </g>
      {mood === "thinking" && (
        <g fill="var(--accent)">
          <circle className="mochi-dot" cx="46" cy="8" r="2.2" />
          <circle className="mochi-dot" cx="53" cy="8" r="2.2" style={{ animationDelay: "0.2s" }} />
          <circle className="mochi-dot" cx="60" cy="8" r="2.2" style={{ animationDelay: "0.4s" }} />
        </g>
      )}
      {mood === "listening" && <path d="M4 18c-3 4-3 9 0 13M9 21c-1.6 2.3-1.6 4.7 0 7" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  );
}

function MochiFace({ mood }: { mood: MochiMood }) {
  if (mood === "happy" || mood === "idle") {
    // Content, eyes closed in a smile: a bow's calm.
    return (
      <g fill="none" stroke={INK} strokeWidth="2.3" strokeLinecap="round">
        <path d="M21.5 41.5q2.5-2.6 5 0M37.5 41.5q2.5-2.6 5 0" />
        <path d="M28.5 47.5q3.5 3.4 7 0" />
      </g>
    );
  }
  if (mood === "thinking") {
    return (
      <g>
        <circle cx="25.5" cy="39.5" r="2.3" fill={INK} />
        <circle cx="40.5" cy="39.5" r="2.3" fill={INK} />
        <path d="M29.5 48.5h5" stroke={INK} strokeWidth="2.3" strokeLinecap="round" />
      </g>
    );
  }
  if (mood === "talking") {
    return (
      <g>
        <circle cx="24" cy="41" r="2.4" fill={INK} />
        <circle cx="40" cy="41" r="2.4" fill={INK} />
        <ellipse className="mochi-talk" cx="32" cy="49" rx="3.6" ry="3.2" fill="#b4314a" stroke={INK} strokeWidth="1.8" />
      </g>
    );
  }
  // listening: wide eyes with a glint, a small "o"
  return (
    <g>
      <circle cx="24" cy="41" r="3.3" fill={INK} />
      <circle cx="40" cy="41" r="3.3" fill={INK} />
      <circle cx="25.2" cy="39.8" r="1" fill="#fff" />
      <circle cx="41.2" cy="39.8" r="1" fill="#fff" />
      <circle cx="32" cy="49" r="1.8" fill="none" stroke={INK} strokeWidth="2" />
    </g>
  );
}

/** Whoever the learner talks to inside the scene. */
export function Tako({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M12 36c0-15 9-25 20-25s20 10 20 25c0 3-1 5-3 6 2 3 5 6 9 7-5 2-10 0-13-3-1 4-4 7-8 8 1-3 1-6 0-8-1 2-4 5-5 5s-4-3-5-5c-1 2-1 5 0 8-4-1-7-4-8-8-3 3-8 5-13 3 4-1 7-4 9-7-2-1-3-3-3-6Z"
        fill="#ff8a7a"
        stroke={INK}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M14 26c10-4 26-4 36 0" fill="none" stroke="#fff8ec" strokeWidth="4" strokeLinecap="round" />
      <circle cx="25" cy="34" r="2.4" fill={INK} />
      <circle cx="39" cy="34" r="2.4" fill={INK} />
      <path d="M29 40q3 2.6 6 0" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** The kids' sidekick: a bean-shaped fox. */
export function Pip({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <path d="M16 22 13 6l13 9M48 22l3-16-13 9" fill="#f7a23b" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M10 38c0-14 10-24 22-24s22 10 22 24-10 20-22 20-22-6-22-20Z" fill="#f7a23b" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M20 44c3 7 9 10 12 10s9-3 12-10c-4 2-8 3-12 3s-8-1-12-3Z" fill="#fff8ec" />
      <circle cx="24" cy="36" r="2.4" fill={INK} />
      <circle cx="40" cy="36" r="2.4" fill={INK} />
      <circle cx="32" cy="43" r="2" fill={INK} />
    </svg>
  );
}

/** The critter for a transcript line's speaker. */
export function SpeakerCritter({ speaker, size = 28 }: { speaker: "narrator" | "character" | "sidekick"; size?: number }) {
  if (speaker === "character") return <Tako size={size} />;
  if (speaker === "sidekick") return <Pip size={size} />;
  return <Mochi size={size} />;
}
