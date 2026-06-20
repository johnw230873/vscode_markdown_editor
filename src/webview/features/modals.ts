// Generic modal handlers: close on backdrop click, close on Escape.

export function initModals(): void {
  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        (modal as HTMLElement).style.display = 'none';
      }
    });
  });

  // Close modals on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach((modal) => {
        (modal as HTMLElement).style.display = 'none';
      });
    }
  });
}
