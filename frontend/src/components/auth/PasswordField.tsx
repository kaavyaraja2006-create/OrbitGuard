import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/** Mirrors the server policy for instant feedback. The server's check is the one that counts. */
export function passwordChecks(pw: string, email = "", name = "") {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const parts = name.toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
  const low = pw.toLowerCase();
  return [
    { ok: pw.length >= 10, label: "10+ characters" },
    { ok: classes >= 3, label: "3 of: lower, upper, digit, symbol" },
    { ok: !(local.length >= 4 && low.includes(local)) && !parts.some((p) => low.includes(p)), label: "Not your name or e-mail" },
  ];
}

export function PasswordField({
  value,
  onChange,
  label = "Password",
  autoComplete = "current-password",
  showStrength = false,
  email,
  name,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  autoComplete?: string;
  showStrength?: boolean;
  email?: string;
  name?: string;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  const auto = useId();
  const fid = id ?? auto;
  const checks = passwordChecks(value, email, name);
  const score = checks.filter((c) => c.ok).length + (value.length >= 14 ? 1 : 0);
  const colors = ["#FF647C", "#FF647C", "#F5B942", "#35D39A", "#35D39A"];
  return (
    <div className="mb-4">
      <label htmlFor={fid} className="mb-1.5 block text-[11.5px] font-medium text-ink-2">
        {label}
      </label>
      <div className="relative">
        <input
          id={fid}
          type={show ? "text" : "password"}
          className="input h-10 w-full pr-10 text-[13px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button type="button" className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {showStrength && (
        <div className="mt-2">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-1 flex-1 rounded-full" style={{ background: value && i < score ? colors[score] : "var(--color-line)" }} />
            ))}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]">
            {checks.map((c) => (
              <li key={c.label} className={c.ok ? "text-ok" : "text-muted"}>
                {c.ok ? "✓" : "·"} {c.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
