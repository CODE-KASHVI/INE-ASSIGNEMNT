import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="py-16">
      <p className="text-sm font-medium text-ink">There's nothing at this address.</p>
      <Link to="/" className="mt-2 inline-block text-sm text-healthy underline">
        Back to the dashboard
      </Link>
    </div>
  );
}
