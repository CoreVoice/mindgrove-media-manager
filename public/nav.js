'use strict';

// Close the Settings <details> dropdown on outside click / after navigating.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.navdrop[open]').forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});

// Mobile hamburger toggle.
const toggle = document.getElementById('navToggle');
const nav = document.getElementById('mainNav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}
