// Objective-C fixture for the language-coverage parity guard.
// Exercises the F#65 objc extractor's main constructs:
//   - #import (system header + project header)
//   - @protocol declaration with required methods
//   - @interface declaration with properties + methods
//   - @implementation block + message expressions
//   - multi-keyword selector reconstruction (the F#65 fix —
//     `initWithName:age:` is one selector spanning two keywords)
#import <Foundation/Foundation.h>
#import "Greeter.h"

@protocol Greetable
- (NSString *)greeting;
@end

@interface Person : NSObject <Greetable>
@property (nonatomic, copy) NSString *name;
@property (nonatomic, assign) NSInteger age;
- (instancetype)initWithName:(NSString *)name age:(NSInteger)age;
- (NSString *)describe;
@end

@implementation Person

- (instancetype)initWithName:(NSString *)name age:(NSInteger)age {
  self = [super init];
  if (self) {
    _name = [name copy];
    _age = age;
  }
  return self;
}

- (NSString *)describe {
  return [NSString stringWithFormat:@"%@ (%ld)", self.name, (long)self.age];
}

- (NSString *)greeting {
  return [NSString stringWithFormat:@"Hello, %@", self.name];
}

@end
