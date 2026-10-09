import React from 'react';
import './experimental-theme.css';
import './catalog.css';

/** Single-line wordmark shared by image catalogs and viewers. */
export default function ExperimentalBrand() {
  return (
    <span className="experimental-brand" role="img" aria-label="OHIF-AI-Experimental">
      <span className="experimental-name">OHIF<span>-AI</span></span>
      <span className="experimental-separator" aria-hidden="true">-</span>
      <span className="experimental-edition">Experimental</span>
    </span>
  );
}
