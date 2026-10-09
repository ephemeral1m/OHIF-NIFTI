import React from 'react';

/** A volume enclosed by a file outline; distinct from DICOM's image/study icon. */
export default function NiftiIcon({ className = 'h-6 w-6', ...props }: React.SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
    <path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9zM14 2v7h7" />
    <path d="m7 13 5-3 5 3-5 3zM7 13v5l5 3 5-3v-5M12 16v5" />
  </svg>;
}
