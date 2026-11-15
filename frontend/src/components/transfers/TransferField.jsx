// A labelled field in the Trades forms.
export default function TransferField({ id, label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}
