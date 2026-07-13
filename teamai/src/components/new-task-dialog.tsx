'use client';

import { useState } from 'react';
import { type FormEvent } from 'react';

interface Template {
  name: string;
  titlePrefix: string;
  descriptionTemplate: string;
  icon: string;
}

interface Props {
  templates: readonly Template[];
  isPending: boolean;
  onClose: () => void;
  onSubmit: (formData: FormData) => void;
}

export function NewTaskDialog({ templates, isPending, onClose, onSubmit }: Props) {
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  function selectTemplate(name: string) {
    const t = templates.find(t => t.name === name);
    if (t) {
      setNewTitle(t.titlePrefix);
      setNewDesc(t.descriptionTemplate);
      setSelectedTemplate(name);
    }
  }

  function clearTemplate() {
    setNewTitle('');
    setNewDesc('');
    setSelectedTemplate(null);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    onSubmit(formData);
  }

  function handleClose() {
    onClose();
    clearTemplate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={handleClose}
      />
      <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4">
        <h2 className="text-base font-semibold text-white mb-4">
          New Task
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Template selector */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Template <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {templates.map(t => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => selectTemplate(t.name)}
                  className={`flex items-center gap-2 px-3 py-2 text-xs rounded-lg border transition-all ${
                    selectedTemplate === t.name
                      ? 'border-[#2563eb] bg-[#2563eb]/10 text-blue-300'
                      : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300 hover:border-[#475569]'
                  }`}
                >
                  <span className="text-sm">{t.icon}</span>
                  {t.name}
                </button>
              ))}
            </div>
            {selectedTemplate && (
              <button
                type="button"
                onClick={clearTemplate}
                className="mt-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear template
              </button>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Title
            </label>
            <input
              name="title"
              required
              placeholder="Add dark mode toggle"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Description
            </label>
            <textarea
              name="description"
              rows={4}
              placeholder="Describe what needs to be done..."
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Reference images <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <input
              name="references"
              type="file"
              accept="image/*"
              multiple
              className="w-full text-sm text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-[#1a1f2e] file:text-slate-300 hover:file:bg-[#1e293b]"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
            >
              {isPending ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
