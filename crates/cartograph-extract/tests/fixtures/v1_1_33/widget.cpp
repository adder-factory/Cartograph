#include "worker.h"

class Widget : public Base {
public:
  int run(int value) { return helper(value); }
};

int Widget::other() { return run(); }
