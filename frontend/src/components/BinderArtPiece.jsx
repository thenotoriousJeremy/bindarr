// One pocket's share of a binder artwork: the whole picture, positioned in
// percentages of this pocket (see pocketImageStyle in utils/binderArtGeometry)
// and clipped by it. Fills its nearest positioned ancestor.
export default function BinderArtPiece({ src, style, className = '' }) {
  if (!src || !style) return null;
  return (
    <div className={`binder-art-piece ${className}`} aria-hidden="true">
      <img
        src={src}
        alt=""
        draggable="false"
        style={{
          left: `${style.leftPct}%`,
          top: `${style.topPct}%`,
          width: `${style.widthPct}%`,
          transform: `translate(-50%, -50%) rotate(${style.rotationDeg}deg)`,
        }}
      />
    </div>
  );
}
