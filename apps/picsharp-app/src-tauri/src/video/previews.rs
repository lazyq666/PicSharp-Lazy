use super::engine::{Cancel, CANCELLED};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

struct Request {
    cancel: Cancel,
    started: bool,
    created: Instant,
}

#[derive(Default)]
pub struct Previews(Mutex<HashMap<String, Request>>);

impl Previews {
    pub fn clean_unused(&self) {
        // Reclaim an unused registration if its webview disappeared before starting it.
        self.0
            .lock()
            .unwrap()
            .retain(|_, r| r.started || r.created.elapsed() < Duration::from_secs(60));
    }

    pub fn prepare(&self) -> String {
        self.clean_unused();
        let mut requests = self.0.lock().unwrap();
        let id = nanoid::nanoid!();
        requests.insert(
            id.clone(),
            Request {
                cancel: Arc::new(AtomicBool::new(false)),
                started: false,
                created: Instant::now(),
            },
        );
        id
    }

    pub fn start(&self, id: &str) -> Result<PreviewRequest<'_>, String> {
        let mut requests = self.0.lock().unwrap();
        let request = requests.get_mut(id).ok_or(CANCELLED)?;
        if request.started {
            return Err("预览请求已启动。".into());
        }
        request.started = true;
        Ok(PreviewRequest {
            owner: self,
            id: id.to_owned(),
            cancel: request.cancel.clone(),
        })
    }

    pub fn cancel(&self, id: &str) {
        let mut requests = self.0.lock().unwrap();
        if let Some(request) = requests.get(id) {
            request.cancel.store(true, Ordering::SeqCst);
            if !request.started {
                requests.remove(id);
            }
        }
    }

    pub fn cancel_all(&self) {
        self.0.lock().unwrap().retain(|_, request| {
            request.cancel.store(true, Ordering::SeqCst);
            request.started
        });
    }

    pub fn idle(&self) -> bool {
        self.0.lock().unwrap().values().all(|r| !r.started)
    }
}

pub struct PreviewRequest<'a> {
    owner: &'a Previews,
    id: String,
    pub cancel: Cancel,
}

impl Drop for PreviewRequest<'_> {
    fn drop(&mut self) {
        self.owner.0.lock().unwrap().remove(&self.id);
    }
}
