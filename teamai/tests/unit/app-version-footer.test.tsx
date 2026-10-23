// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppVersionFooter } from '@/components/app-version-footer';

describe('AppVersionFooter', () => {
  it('renders the fallback sha when the build SHA is unknown', () => {
    render(<AppVersionFooter initialVersion="0.3.0" initialSha="unknown" />);
    expect(screen.getByText('Version 0.3.0:unknown')).toBeInTheDocument();
  });

  it('renders nothing when the version is empty', () => {
    const { container } = render(<AppVersionFooter initialVersion="" initialSha="abcdef1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
