'use client';

const INPUT_CLASS =
  'w-20 px-2 py-1 text-sm border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]';

export interface BudgetInputProps {
  label: string;
  tooltip: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * A stall-budget input followed by its hard-cap ("rounds") input. State is owned
 * by the parent (initialised from props), so this component never fetches.
 */
export function BudgetPairInputs({ stall, rounds }: { stall: BudgetInputProps; rounds: BudgetInputProps }) {
  return (
    <>
      {[stall, rounds].map(input => (
        <div key={input.label} title={input.tooltip}>
          <label className="text-xs font-medium text-slate-400 block mb-1">
            {input.label}
          </label>
          <input
            type="number"
            min={input.min}
            max={input.max}
            value={input.value}
            onChange={e => input.onChange(Number(e.target.value))}
            className={INPUT_CLASS}
          />
        </div>
      ))}
    </>
  );
}
