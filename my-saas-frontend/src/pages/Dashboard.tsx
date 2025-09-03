import  { useState, useEffect } from 'react';
import { supabase } from '../supabase/supabaseClient.ts';
import { useAuth } from '../components/AuthProvider.tsx';

const DashboardPage = () => {
  const { session } = useAuth();
  const [tokens, setTokens] = useState(0);
  const [subscriptionStatus, setSubscriptionStatus] = useState("Checking...");
  const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL;

  const fetchUserData = async () => {
    if (!session) return;

    // Fetch total tokens from the view
    const { data: tokenData, error: tokenError } = await supabase
      .from('user_token_total')
      .select('total_available')
      .eq('user_id', session.user.id)
      .single();

    if (tokenError) {
      console.error('Error fetching tokens:', tokenError);
      setTokens(0);
    } else {
      setTokens(tokenData?.total_available || 0);
    }

    // Fetch subscription status
    const { data: subData, error: subError } = await supabase
      .from('subscriptions')
      .select('is_active')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (subError) {
      console.error('Error fetching subscription status:', subError);
      setSubscriptionStatus("No active subscription");
    } else {
      setSubscriptionStatus(subData?.is_active ? "Active" : "No active subscription");
    }
  };

  const handleCancelSubscription = async () => {
    if (!session) return;
    try {
      const response = await fetch(`${functionsUrl}/cancel_subscription`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();
      if (response.ok) {
        alert(data.message);
        setSubscriptionStatus("Cancellation scheduled");
      } else {
        alert(data.error || 'Failed to cancel subscription.');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('An internal error occurred.');
    }
  };

  useEffect(() => {
    fetchUserData();
  }, [session]);

  return (
    <div className="dashboard-container">
      <h1>Your Dashboard</h1>
      <div className="dashboard-card">
        <h3>Current Status</h3>
        <p>Token Balance: **{tokens}**</p>
        <p>Subscription Status: **{subscriptionStatus}**</p>
        {subscriptionStatus === "Active" && (
          <button onClick={handleCancelSubscription} className="cancel-button">
            Cancel Subscription
          </button>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;