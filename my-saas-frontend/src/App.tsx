import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import AuthPage from './pages/Auth.tsx';
import PricingPage from './pages/Pricing.tsx';
import DashboardPage from './pages/Dashboard.tsx';
import { AuthProvider, useAuth } from './components/AuthProvider.tsx';
import { supabase } from './supabase/supabaseClient.ts';
import './index.css';

const AppContent = () => {
  const { session } = useAuth();
  
  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="app-container">
      <nav className="navbar">
        <div className="logo">LayerVibe</div>
        <div className="nav-links">
          <Link to="/pricing">Pricing</Link>
          {session ? (
            <>
              <Link to="/dashboard">Dashboard</Link>
              <button onClick={handleSignOut} className="sign-out-button">
                Sign Out
              </button>
            </>
          ) : (
            <Link to="/">Sign In</Link>
          )}
        </div>
      </nav>
      <div className="content">
        <Routes>
          <Route path="/" element={<AuthPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          {session && (
            <Route path="/dashboard" element={<DashboardPage />} />
          )}
        </Routes>
      </div>
    </div>
  );
};

const App = () => (
  <Router>
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  </Router>
);

export default App;