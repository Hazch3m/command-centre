//! Weather from Open-Meteo (free, no account or key). Only this one host is reachable.

use serde_json::Value;
use std::time::Duration;

const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";

pub fn forecast_url(lat: f64, lon: f64) -> Result<String, String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("That location isn't valid".into());
    }
    Ok(format!(
        "{FORECAST}?latitude={lat:.4}&longitude={lon:.4}&timezone=auto&forecast_days=3\
         &current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation\
         &hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,weather_code,is_day\
         &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset"
    ))
}

/// Network failures start with "offline:" so the card can show its cached forecast.
#[tauri::command]
pub async fn weather_fetch(http: tauri::State<'_, reqwest::Client>, lat: f64, lon: f64) -> Result<Value, String> {
    let url = forecast_url(lat, lon)?;
    let resp = http.get(url).timeout(Duration::from_secs(20)).send().await.map_err(|e| format!("offline: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The weather service replied {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_forecast_address() {
        let u = forecast_url(46.2044, 6.1432).unwrap();
        assert!(u.starts_with("https://api.open-meteo.com/v1/forecast?latitude=46.2044&longitude=6.1432"));
        assert!(forecast_url(120.0, 0.0).is_err());
    }
}
