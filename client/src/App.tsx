import { Route, Routes } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="*" element={<div className="p-8 text-lg font-semibold">SubFlow</div>} />
    </Routes>
  );
}
