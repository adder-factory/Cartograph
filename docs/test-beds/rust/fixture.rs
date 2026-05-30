// Rust test bed
use std::collections::Vec;

pub struct Box<T> { pub value: T }

pub struct Container<T> { items: Vec<Box<T>> }

impl<T> Container<T> {
    pub fn new() -> Self { Container { items: Vec::new() } }
    pub fn add(&mut self, item: Box<T>) { self.items.push(item); }
    pub fn size(&self) -> usize { self.items.len() }
}

pub trait Logger {
    fn log(&self);
}

pub fn process(input: Box<String>) -> Container<String> {
    let mut c = Container::new();
    c.add(input);
    c
}

const FOO: i32 = 42;
